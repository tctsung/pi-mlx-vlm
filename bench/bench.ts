// Benchmark one model: Ollama (optional) vs mlx-vlm with each pulled drafter, on streamed decode speed and a real Pi agent task; appends one sample per run to bench/results.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toModels } from "../src/index.ts";
import { known } from "../src/models.mjs";

const { values: opt } = parseArgs({
  options: {
    model: { type: "string", default: "qwen3.5-9b" },
    ollama: { type: "string", default: "" },
    reps: { type: "string", default: "3" },
    thinking: { type: "string", default: "off,medium" },
    out: { type: "string", default: "bench/results.json" },
    "decode-only": { type: "boolean", default: false },
  },
});
const reps = Number(opt.reps);
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const portFile = join(agentDir, "mlx-vlm", "port");
const OLLAMA = "http://127.0.0.1:11434";
const MLX = `http://127.0.0.1:${process.env.PI_MLX_PORT ?? (existsSync(portFile) ? readFileSync(portFile, "utf8").trim() : 8080)}`;
const [model, k] = known(opt.model!) ?? [opt.model!];
const target = k?.repo ?? model;
const pairs = JSON.parse(readFileSync(join(agentDir, "mlx-vlm.json"), "utf8")).models.filter((m: any) => m.target === target);
if (!pairs.length) throw new Error(`${model} is not pulled; run pi-mlx pull ${model}`);

type Config = { config: string; base: string; model: string; pi: string; draft?: { draft_model: string | null; draft_kind: string | null } };
const configs: Config[] = [
  ...(opt.ollama ? [{ config: "ollama", base: OLLAMA, model: opt.ollama, pi: `ollama/${opt.ollama}` }] : []),
  ...pairs.map((e: any) => ({ config: e.id.split("@")[1] ?? "none", base: MLX, model: e.path ?? e.target, pi: `mlx/${e.id}`, draft: { draft_model: e.draft, draft_kind: e.kind } })),
];

const PROMPTS = [
  "Write a Python function that parses an ISO-8601 date string without using datetime, with docstring and tests.",
  "Explain how a B-tree insert works, step by step, with a small worked example.",
  "Implement an LRU cache class in TypeScript with get/put and O(1) operations, then show usage.",
];
const TASK = "Create fib.py with fib(n) returning the nth Fibonacci number (fib(0)=0) and test_fib.py with 3 unittest cases. Run python3 -m unittest and report the result.";
const json = { "content-type": "application/json" };

async function prepare(c: Config) {
  if (c.base === MLX) {
    if (opt.ollama) await fetch(`${OLLAMA}/api/generate`, { method: "POST", headers: json, body: JSON.stringify({ model: opt.ollama, keep_alive: 0 }) });
    await fetch(`${MLX}/v1/settings`, { method: "PATCH", headers: json, body: JSON.stringify(c.draft) });
  } else {
    await fetch(`${MLX}/unload`, { method: "POST" }).catch(() => {});
  }
  await stream(c, "Say hi.", 8, "off");
}

const [family] = toModels([{ id: model, target, draft: null, kind: null, family: k?.family ?? "default" }]);
const sampling = (thinking: string) => ({ ...family.samplingParams, ...(thinking === "off" ? family.samplingParamsByThinkingLevel?.off : {}) });

async function stream(c: Config, prompt: string, maxTokens: number, thinking: string) {
  const t0 = performance.now();
  let first = 0, last = 0, tokens = 0, buf = "";
  const res = await fetch(`${c.base}/v1/chat/completions`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      model: c.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, reasoning_effort: thinking === "off" ? "none" : thinking,
      ...sampling(thinking), messages: [{ role: "user", content: prompt }],
    }),
  });
  for await (const chunk of res.body!) {
    buf += Buffer.from(chunk).toString();
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: {")) continue;
      const ev = JSON.parse(line.slice(6));
      const d = ev.choices?.[0]?.delta;
      if (d?.content || d?.reasoning) (first ||= performance.now()), (last = performance.now());
      if (ev.usage) tokens = ev.usage.completion_tokens;
    }
  }
  return { tps: (tokens - 1) / ((last - first) / 1000), ttft: (first - t0) / 1000, tokens };
}

function piTask(c: Config, thinking: string) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bench-"));
  const t0 = performance.now();
  const run = spawnSync("pi", ["-p", "--no-session", "--model", c.pi, "--thinking", thinking, "--mode", "json", TASK], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 30 });
  const secs = (performance.now() - t0) / 1000;
  const ok = spawnSync("python3", ["-m", "unittest", "-q"], { cwd: dir }).status === 0;
  const usage = run.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message.usage ?? {});
  return { secs, ok, turns: usage.length, output: usage.reduce((s, u) => s + (u.output ?? 0), 0) };
}

const machine = `${spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim()} ${Math.round(totalmem() / 2 ** 30)} GB`;
const samples: object[] = existsSync(opt.out!) ? JSON.parse(readFileSync(opt.out!, "utf8")) : [];
const save = () => writeFileSync(opt.out!, `[\n${samples.map((s) => JSON.stringify(s)).join(",\n")}\n]\n`);
for (const c of configs) {
  await prepare(c);
  const base = { date: new Date().toISOString(), machine, model, config: c.config, ...(c.config === "ollama" ? { ollama: opt.ollama } : {}) };
  for (const thinking of opt.thinking!.split(",")) {
    const runs = [];
    for (let r = 0; r < reps; r++) for (const p of PROMPTS) runs.push(await stream(c, p, 512, thinking));
    samples.push(...runs.map((x) => ({ ...base, thinking, kind: "decode", ...x })));
    console.log(model, c.config, thinking, "decode tok/s", (runs.reduce((s, x) => s + x.tps, 0) / runs.length).toFixed(1));
  }
  if (!opt["decode-only"]) for (const thinking of opt.thinking!.split(",")) {
    const tasks = Array.from({ length: reps }, () => piTask(c, thinking));
    samples.push(...tasks.map((x) => ({ ...base, thinking, kind: "task", ...x })));
    console.log(model, c.config, thinking, "task s", tasks.map((t) => `${t.secs.toFixed(0)}${t.ok ? "" : "!"}`).join(" "));
  }
  save();
}
