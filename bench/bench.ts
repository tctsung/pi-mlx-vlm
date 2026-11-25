// Benchmark: Ollama vs mlx-vlm (no drafter, MTP, DFlash) on streamed decode speed and on a real Pi agent task; writes bench/results.json. Needs both servers up and the mlx pairings pulled.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { known, toModels } from "../src/index.ts";

const { values: opt } = parseArgs({
  options: {
    ollama: { type: "string", default: "qwen3.5:9b-mlx" },
    mlx: { type: "string", default: "mlx-community/Qwen3.5-9B-4bit" },
    reps: { type: "string", default: "3" },
    thinking: { type: "string", default: "off,medium" },
    out: { type: "string", default: "bench/results.json" },
    "decode-only": { type: "boolean", default: false },
  },
});
const reps = Number(opt.reps);
const OLLAMA = "http://127.0.0.1:11434";
const MLX = `http://127.0.0.1:${process.env.PI_MLX_PORT ?? 8080}`;
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const pairs = JSON.parse(readFileSync(join(agentDir, "mlx-vlm.json"), "utf8")).models.filter((m: any) => m.target === opt.mlx);
const LABEL: Record<string, string> = { "": "mlx-vlm", mtp: "mlx-vlm + MTP", dflash: "mlx-vlm + DFlash", dflash2: "mlx-vlm + DFlash2", dspark: "mlx-vlm + DSpark" };

type Config = { label: string; base: string; model: string; pi: string; draft?: { draft_model: string | null; draft_kind: string | null } };
const configs: Config[] = [
  { label: "Ollama (MLX)", base: OLLAMA, model: opt.ollama!, pi: `ollama/${opt.ollama}` },
  ...pairs.map((e: any) => ({ label: LABEL[e.id.split("@")[1] ?? ""], base: MLX, model: e.target, pi: `mlx/${e.id}`, draft: { draft_model: e.draft, draft_kind: e.kind } })),
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
    await fetch(`${OLLAMA}/api/generate`, { method: "POST", headers: json, body: JSON.stringify({ model: opt.ollama, keep_alive: 0 }) });
    await fetch(`${MLX}/v1/settings`, { method: "PATCH", headers: json, body: JSON.stringify(c.draft) });
  } else {
    await fetch(`${MLX}/unload`, { method: "POST" }).catch(() => {});
  }
  await stream(c, "Say hi.", 8, "off");
}

const [family] = toModels([{ id: opt.mlx!, target: opt.mlx!, draft: null, kind: null, family: known(opt.mlx!)?.[1].family ?? "default" }]);
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

const results: any = { date: new Date().toISOString(), machine: spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim(), ollama: opt.ollama, mlx: opt.mlx, task: TASK, decode: [], tasks: [] };
for (const c of configs) {
  await prepare(c);
  for (const thinking of opt.thinking!.split(",")) {
    const runs = [];
    for (let r = 0; r < reps; r++) for (const p of PROMPTS) runs.push(await stream(c, p, 512, thinking));
    results.decode.push({ label: c.label, thinking, runs });
    console.log(c.label, thinking, "decode tok/s", (runs.reduce((s, x) => s + x.tps, 0) / runs.length).toFixed(1));
  }
  if (!opt["decode-only"]) for (const thinking of opt.thinking!.split(",")) {
    const tasks = Array.from({ length: reps }, () => piTask(c, thinking));
    results.tasks.push({ label: c.label, thinking, runs: tasks });
    console.log(c.label, thinking, "task s", tasks.map((t) => `${t.secs.toFixed(0)}${t.ok ? "" : "!"}`).join(" "));
  }
  writeFileSync(opt.out!, JSON.stringify(results, null, 2));
}
