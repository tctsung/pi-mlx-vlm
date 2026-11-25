// Tests for pi-mlx-vlm: pure catalog/pull/migration logic, plus the extension wired to a fake Pi and a fake mlx-vlm server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const settings: Record<string, unknown> = { draft_model: null, draft_kind: null };
const patches: unknown[] = [];
const metrics = { summary: { in_flight: 1, last_request_at: 0 }, server: { loaded_model: "m" as string | null } };
let unloads = 0;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "healthy", loaded_model: "m", loaded_models: {} }));
    if (req.url === "/v1/settings" && req.method === "GET") return res.end(JSON.stringify({ current: settings }));
    if (req.url === "/v1/settings" && req.method === "PATCH") {
      const p = JSON.parse(body);
      patches.push(p);
      Object.assign(settings, p);
      return res.end(JSON.stringify({ applied: p, rejected: [], current: settings }));
    }
    if (req.url === "/metrics") return res.end(JSON.stringify(metrics));
    if (req.url === "/unload") return unloads++, res.end(JSON.stringify({ status: "success" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
process.env.PI_MLX_PORT = String((fake.address() as AddressInfo).port);
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-mlx-"));
const mod = await import("../src/index.ts");
const { KNOWN, toModels, planPull, fromOllama, serverArgs, parsePullArgs, SERVER_ENV, setBlock, keepAlive, WATCHDOG } = mod;
test.after(() => fake.close());

const Q35 = "mlx-community/Qwen3.5-9B-4bit";
const Q38 = "mlx-community/Qwen3.8-27B-8bit";

test("catalog only lists verified drafter pairs", () => {
  assert.equal(KNOWN[Q38].mtp, "mlx-community/Qwen3.8-27B-MTP-4bit");
  assert.equal(KNOWN[Q38].dflash, "z-lab/Qwen3.8-27B-DFlash2");
  assert.equal(KNOWN["mlx-community/Qwen3.8-27B-4bit"].dflash, "z-lab/Qwen3.8-27B-DFlash2");
  assert.equal(KNOWN[Q35].mtp, "mlx-community/Qwen3.5-9B-MTP-4bit");
  assert.equal(KNOWN[Q35].dflash, "z-lab/Qwen3.5-9B-DFlash");
});

test("server always binds loopback and never pins a drafter at startup", () => {
  const args = serverArgs();
  assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
  assert.ok(!args.includes("--draft-model"));
  assert.ok(!args.includes("0.0.0.0"));
});

test("server defaults: in-memory prefix cache (never disk), one sequence at a time like OLLAMA_NUM_PARALLEL", () => {
  assert.deepEqual(SERVER_ENV, { APC_ENABLED: "1", APC_DISK_ENABLED: "0", MLX_VLM_MAX_NUM_SEQS: "1" });
});

test("keep-alive uses Ollama's duration format, default 5m, negative means never", () => {
  assert.equal(keepAlive(undefined), 300);
  assert.equal(keepAlive("10m"), 600);
  assert.equal(keepAlive("90"), 90);
  assert.equal(keepAlive("2h"), 7200);
  assert.equal(keepAlive("0"), 0);
  assert.equal(keepAlive("-1"), -1);
  assert.equal(keepAlive("soon"), 300);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("watchdog unloads only when idle with nothing in flight, and exits when the server is gone", async () => {
  const base = `http://127.0.0.1:${process.env.PI_MLX_PORT}`;
  const dog = spawn(process.execPath, [WATCHDOG, base, String(process.pid), "0"], { stdio: "inherit" });
  const before = unloads;
  await sleep(2500);
  assert.equal(unloads, before, "busy server must not be unloaded");
  metrics.summary.in_flight = 0;
  await sleep(2500);
  assert.ok(unloads > before, "idle server should be unloaded");
  metrics.server.loaded_model = null;
  const after = unloads;
  await sleep(1500);
  assert.equal(unloads, after, "nothing loaded, nothing to unload");
  dog.kill();
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("exit", r));
  const orphan = spawn(process.execPath, [WATCHDOG, base, String(dead.pid), "0"]);
  const code = await Promise.race([new Promise((r) => orphan.on("exit", r)), sleep(3000).then(() => "still running")]);
  orphan.kill();
  assert.equal(code, 0);
});

test("each pulled pairing becomes its own model with the family thinking map", () => {
  const models = toModels([
    { id: `${Q38}@mtp`, target: Q38, draft: "mlx-community/Qwen3.8-27B-MTP-4bit", kind: "mtp", family: "qwen3.8" },
    { id: `${Q35}@dflash`, target: Q35, draft: "/d/Qwen3.5-9B-DFlash-4bit", kind: "dflash", family: "qwen3.5" },
    { id: "x/y", target: "x/y", draft: null, kind: null, family: "default" },
  ]);
  assert.deepEqual(models.map((m) => m.id), [`${Q38}@mtp`, `${Q35}@dflash`, "x/y"]);
  const [q38, q35, plain] = models;
  assert.deepEqual(q38.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: "medium", high: "xhigh" });
  assert.deepEqual(q35.thinkingLevelMap, { off: "none", minimal: null, low: null, medium: "medium", high: null });
  assert.deepEqual([(q38.compat as any).thinkingFormat, (q38.compat as any).supportsReasoningEffort], ["openai", true]);
  assert.deepEqual(q38.samplingParams, { temperature: 1, top_p: 0.95, top_k: 20 });
  assert.equal((q38 as any).samplingParamsByThinkingLevel, undefined);
  assert.equal(q35.samplingParams?.presence_penalty, 1.5);
  assert.deepEqual((q35 as any).samplingParamsByThinkingLevel.off, { temperature: 0.7, top_p: 0.8 });
  assert.equal(plain.samplingParams, undefined);
  assert.match(q38.name, /MTP/);
  assert.match(q35.name, /DFlash/);
  assert.ok(models.every((m) => m.reasoning && m.cost.input === 0));
});

test("pull plan downloads target and MTP, converts DFlash to 4-bit once", () => {
  const plan = planPull(Q35, ["mtp", "dflash"], undefined, "/drafters");
  assert.deepEqual(plan.steps, [
    ["hf", ["download", Q35]],
    ["hf", ["download", "mlx-community/Qwen3.5-9B-MTP-4bit"]],
    ["mlx_vlm.convert", ["--hf-path", "z-lab/Qwen3.5-9B-DFlash", "--mlx-path", "/drafters/Qwen3.5-9B-DFlash-4bit", "--quantize", "--q-bits", "4", "--q-group-size", "64"]],
  ]);
  assert.deepEqual(plan.entries.map((e) => [e.id, e.draft, e.kind]), [
    [Q35, null, null],
    [`${Q35}@mtp`, "mlx-community/Qwen3.5-9B-MTP-4bit", "mtp"],
    [`${Q35}@dflash`, "/drafters/Qwen3.5-9B-DFlash-4bit", "dflash"],
  ]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.block, { path: "/drafters/Qwen3.5-9B-DFlash-4bit", size: 4 });
  assert.equal(planPull(Q38, ["dflash"], undefined, "/d").block, undefined);
});

test("DFlash block size is written into the converted drafter config", () => {
  const dir = mkdtempSync(join(tmpdir(), "drafter-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "qwen3", block_size: 16 }));
  setBlock(dir, 4);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { model_type: "qwen3", block_size: 4 });
});

test("unknown model needs --draft, otherwise only the plain entry is added", () => {
  const bare = planPull("someone/Model-4bit", ["mtp", "dflash"], undefined, "/d");
  assert.deepEqual(bare.entries.map((e) => e.id), ["someone/Model-4bit"]);
  assert.equal(bare.warnings.length, 2);
  const withDraft = planPull("someone/Model-4bit", ["dflash"], "someone/Model-DFlash", "/d");
  assert.deepEqual(withDraft.entries.map((e) => e.id), ["someone/Model-4bit", "someone/Model-4bit@dflash"]);
  assert.equal(withDraft.entries[1].family, "default");
});

test("pull args parse repo, methods and --draft", () => {
  assert.deepEqual(parsePullArgs(`${Q35}`), { target: Q35, methods: ["mtp", "dflash"], draft: undefined });
  assert.deepEqual(parsePullArgs(`${Q35} dflash`), { target: Q35, methods: ["dflash"], draft: undefined });
  assert.deepEqual(parsePullArgs("a/b mtp --draft c/d"), { target: "a/b", methods: ["mtp"], draft: "c/d" });
  assert.equal(parsePullArgs(""), undefined);
});

test("ollama tags map to their MLX equivalents", () => {
  const out = "NAME                ID      SIZE\nqwen3.8:27b-mlx     5642    18 GB\nqwen3.5:9b-mlx      203e    8.9 GB\nllama3:8b  x  4 GB\n";
  assert.deepEqual(fromOllama(out), ["mlx-community/Qwen3.8-27B-4bit", Q35]);
  assert.deepEqual(fromOllama(""), []);
});

function fakePi() {
  const handlers: Record<string, Function> = {};
  const providers: [string, any][] = [];
  const commands: Record<string, any> = {};
  const execs: string[][] = [];
  const notes: string[] = [];
  const pi = {
    on: (e: string, h: Function) => (handlers[e] = h),
    registerProvider: (n: string, c: any) => providers.push([n, c]),
    registerCommand: (n: string, o: any) => (commands[n] = o),
    exec: async (cmd: string, args: string[]) => {
      execs.push([cmd, ...args]);
      if (cmd.endsWith("mlx_vlm.convert")) {
        const out = args[args.indexOf("--mlx-path") + 1];
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "config.json"), JSON.stringify({ block_size: 16 }));
      }
      return { code: 0, stdout: cmd.endsWith("ollama") ? "NAME ID\nqwen3.5:9b-mlx 203e\n" : "", stderr: "", killed: false };
    },
    setModel: async () => true,
  };
  const ctx = (model?: { provider: string; id: string }, hasUI = true) => ({
    model,
    hasUI,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => {}, confirm: async () => true, select: async (_: string, o: string[]) => o[0] },
    modelRegistry: { find: () => undefined },
  });
  return { pi, handlers, providers, commands, execs, notes, ctx };
}

test("extension registers mlx provider on 127.0.0.1 with a dummy key and /mlx command", () => {
  const f = fakePi();
  mod.default(f.pi as any);
  const [name, cfg] = f.providers[0];
  assert.equal(name, "mlx");
  assert.equal(cfg.baseUrl, `http://127.0.0.1:${process.env.PI_MLX_PORT}/v1`);
  assert.equal(cfg.api, "openai-completions");
  assert.ok(cfg.apiKey);
  assert.ok(f.commands.mlx);
});

test("before request: drafter set only when it differs, model id rewritten to target", async () => {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  writeFileSync(join(dir, "mlx-vlm.json"), JSON.stringify({ models: [
    { id: `${Q35}@mtp`, target: Q35, draft: "mlx-community/Qwen3.5-9B-MTP-4bit", kind: "mtp", family: "qwen3.5" },
    { id: Q35, target: Q35, draft: null, kind: null, family: "qwen3.5" },
  ] }));
  const f = fakePi();
  mod.default(f.pi as any);
  const hook = f.handlers.before_provider_request;
  patches.length = 0;
  const out = await hook({ payload: { model: `${Q35}@mtp`, messages: [] } }, f.ctx({ provider: "mlx", id: `${Q35}@mtp` }));
  assert.equal(out.model, Q35);
  assert.deepEqual(patches, [{ draft_model: "mlx-community/Qwen3.5-9B-MTP-4bit", draft_kind: "mtp" }]);
  await hook({ payload: { model: `${Q35}@mtp` } }, f.ctx({ provider: "mlx", id: `${Q35}@mtp` }));
  assert.equal(patches.length, 1);
  await hook({ payload: { model: Q35 } }, f.ctx({ provider: "mlx", id: Q35 }));
  assert.deepEqual(patches[1], { draft_model: null, draft_kind: null });
  assert.equal(await hook({ payload: { model: "qwen3.5:9b-mlx" } }, f.ctx({ provider: "ollama", id: "qwen3.5:9b-mlx" })), undefined);
});

test("/mlx pull runs the plan, saves the catalog and refreshes the provider", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  await f.commands.mlx.handler(`pull ${Q35} mtp`, f.ctx());
  assert.deepEqual(f.execs.map((e) => e.slice(1)), [["download", Q35], ["download", "mlx-community/Qwen3.5-9B-MTP-4bit"]]);
  const saved = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "mlx-vlm.json"), "utf8"));
  assert.ok(saved.models.some((m: any) => m.id === `${Q35}@mtp`));
  const last = f.providers.at(-1)![1];
  assert.ok(last.models.some((m: any) => m.id === `${Q35}@mtp`));
});

test("/mlx status and unload talk to the server", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  await f.commands.mlx.handler("status", f.ctx());
  assert.match(f.notes.join("\n"), /127\.0\.0\.1/);
  await f.commands.mlx.handler("unload", f.ctx());
  assert.match(f.notes.at(-1)!, /unload/i);
});

test("/mlx setup without UI picks the MLX match of an installed Ollama model and prints progress", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  const log = console.log;
  const printed: string[] = [];
  console.log = (m: string) => printed.push(m);
  try {
    await f.commands.mlx.handler("setup", f.ctx(undefined, false));
  } finally {
    console.log = log;
  }
  assert.ok(f.execs.some((e) => e.slice(1).join(" ") === `download ${Q35}`), JSON.stringify(f.execs));
  assert.equal(f.notes.length, 0);
  assert.match(printed.join("\n"), /Added mlx\//);
  const drafter = join(process.env.PI_CODING_AGENT_DIR!, "mlx-vlm", "drafters", "Qwen3.5-9B-DFlash-4bit", "config.json");
  assert.equal(JSON.parse(readFileSync(drafter, "utf8")).block_size, 4);
});
