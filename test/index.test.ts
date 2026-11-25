// Tests for pi-mlx-vlm: pure catalog/pull logic, plus the extension wired to a fake Pi and a fake mlx-vlm server.
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
const { CATALOG, known, toModels, planPull, serverArgs, parsePullArgs, SERVER_ENV, setBlock, keepAlive, WATCHDOG } = mod;
test.after(() => fake.close());

const Q35 = "mlx-community/Qwen3.5-9B-4bit";
const Q38 = "mlx-community/Qwen3.8-27B-8bit";

test("catalog: easy names for Qwen3.8, Qwen3.5, Gemma 4, LFM, each with a repo, size and verified drafters", () => {
  for (const family of ["qwen3.8-", "qwen3.5-", "gemma4-", "lfm3-", "lfm3-vl-", "lfm2.5-"]) assert.ok(Object.keys(CATALOG).some((n) => n.startsWith(family)), family);
  for (const [name, k] of Object.entries(CATALOG)) assert.ok(k.repo.includes("/") && k.gb! > 0, name);
  assert.equal(CATALOG["qwen3.8-27b"].dflash2, "z-lab/Qwen3.8-27B-DFlash2");
  assert.equal(CATALOG["qwen3.8-27b-8bit"].repo, Q38);
  assert.equal(CATALOG["qwen3.5-9b"].mtp, "mlx-community/Qwen3.5-9B-MTP-4bit");
  assert.equal(CATALOG["gemma4-e4b"].mtp, "mlx-community/gemma-4-E4B-it-assistant-bf16");
  assert.equal(CATALOG["lfm2.5-2.6b"].dspark, "LiquidAI/LFM2.5-2.6B-DSpark");
  assert.equal(known(Q35)?.[0], "qwen3.5-9b");
  assert.equal(known("qwen3.5-9b")?.[1].repo, Q35);
  assert.equal(known("someone/else"), undefined);
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
    { id: "qwen3.8-27b@dflash2", target: "mlx-community/Qwen3.8-27B-4bit", draft: "/d/Qwen3.8-27B-DFlash2-4bit", kind: "dflash", family: "qwen3.8" },
    { id: "gemma4-e4b@mtp", target: "mlx-community/gemma-4-E4B-it-4bit", draft: "mlx-community/gemma-4-E4B-it-assistant-bf16", kind: "mtp", family: "gemma4" },
  ]);
  assert.deepEqual(models.map((m) => m.id), [`${Q38}@mtp`, `${Q35}@dflash`, "x/y", "qwen3.8-27b@dflash2", "gemma4-e4b@mtp"]);
  const [q38, q35, plain, dflash2, gemma] = models;
  assert.deepEqual(q38.thinkingLevelMap, { off: "none", minimal: null, low: "low", medium: "medium", high: "xhigh" });
  assert.deepEqual(q35.thinkingLevelMap, { off: "none", minimal: null, low: null, medium: "medium", high: null });
  assert.deepEqual([(q38.compat as any).thinkingFormat, (q38.compat as any).supportsReasoningEffort], ["openai", true]);
  assert.deepEqual(q38.samplingParams, { temperature: 1, top_p: 0.95, top_k: 20 });
  assert.equal((q38 as any).samplingParamsByThinkingLevel, undefined);
  assert.equal(q35.samplingParams?.presence_penalty, 1.5);
  assert.deepEqual((q35 as any).samplingParamsByThinkingLevel.off, { temperature: 0.7, top_p: 0.8 });
  assert.equal(plain.samplingParams, undefined);
  assert.equal(q38.name, "Qwen3.8-27B-8bit MTP");
  assert.equal(q35.name, "Qwen3.5-9B-4bit DFlash");
  assert.equal(plain.name, "y no drafter");
  assert.equal(dflash2.name, "qwen3.8-27b DFlash2");
  assert.deepEqual(gemma.input, ["text", "image"]);
  assert.equal(gemma.samplingParams?.top_k, 64);
  assert.ok(models.every((m) => m.reasoning && m.cost.input === 0));
});

test("pull plan by easy name: every catalog drafter, DFlash converted to 4-bit once, MTP and DSpark downloaded", () => {
  const plan = planPull("qwen3.5-9b", [], undefined, "/drafters");
  assert.deepEqual(plan.steps, [
    ["hf", ["download", Q35]],
    ["mlx_vlm.convert", ["--hf-path", "z-lab/Qwen3.5-9B-DFlash", "--mlx-path", "/drafters/Qwen3.5-9B-DFlash-4bit", "--quantize", "--q-bits", "4", "--q-group-size", "64"]],
    ["hf", ["download", "mlx-community/Qwen3.5-9B-MTP-4bit"]],
  ]);
  assert.deepEqual(plan.entries.map((e) => [e.id, e.draft, e.kind]), [
    ["qwen3.5-9b", null, null],
    ["qwen3.5-9b@dflash", "/drafters/Qwen3.5-9B-DFlash-4bit", "dflash"],
    ["qwen3.5-9b@mtp", "mlx-community/Qwen3.5-9B-MTP-4bit", "mtp"],
  ]);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.block, { path: "/drafters/Qwen3.5-9B-DFlash-4bit", size: 4 });
  assert.deepEqual(planPull(Q35, ["mtp"], undefined, "/d").entries.map((e) => e.id), ["qwen3.5-9b", "qwen3.5-9b@mtp"]);
  const q38 = planPull("qwen3.8-27b", ["dflash2"], undefined, "/d");
  assert.deepEqual(q38.entries[1], { id: "qwen3.8-27b@dflash2", target: "mlx-community/Qwen3.8-27B-4bit", draft: "/d/Qwen3.8-27B-DFlash2-4bit", kind: "dflash", family: "qwen3.8" });
  assert.equal(q38.block, undefined);
  const lfm = planPull("lfm2.5-2.6b", [], undefined, "/d");
  assert.deepEqual(lfm.steps, [["hf", ["download", "LiquidAI/LFM2.5-2.6B"]], ["hf", ["download", "LiquidAI/LFM2.5-2.6B-DSpark"]]]);
  assert.deepEqual(lfm.entries[1], { id: "lfm2.5-2.6b@dspark", target: "LiquidAI/LFM2.5-2.6B", draft: "LiquidAI/LFM2.5-2.6B-DSpark", kind: "dflash", family: "default" });
  assert.deepEqual(planPull("lfm3-1.7b", [], undefined, "/d").entries.map((e) => e.id), ["lfm3-1.7b"]);
});

test("DFlash block size is written into the converted drafter config", () => {
  const dir = mkdtempSync(join(tmpdir(), "drafter-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "qwen3", block_size: 16 }));
  setBlock(dir, 4);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")), { model_type: "qwen3", block_size: 4 });
});

test("unknown model needs --draft, otherwise only the plain entry is added", () => {
  const bare = planPull("someone/Model-4bit", [], undefined, "/d");
  assert.deepEqual(bare.entries.map((e) => e.id), ["someone/Model-4bit"]);
  assert.match(bare.warnings.join(), /not in the catalog/);
  assert.equal(planPull("someone/Model-4bit", ["mtp", "dflash"], undefined, "/d").warnings.length, 2);
  const withDraft = planPull("someone/Model-4bit", ["dflash"], "someone/Model-DFlash", "/d");
  assert.deepEqual(withDraft.entries.map((e) => e.id), ["someone/Model-4bit", "someone/Model-4bit@dflash"]);
  assert.equal(withDraft.entries[1].family, "default");
});

test("pull args parse name or repo, methods and --draft", () => {
  assert.deepEqual(parsePullArgs("qwen3.5-9b"), { target: "qwen3.5-9b", methods: [], draft: undefined });
  assert.deepEqual(parsePullArgs(`${Q35} dflash`), { target: Q35, methods: ["dflash"], draft: undefined });
  assert.deepEqual(parsePullArgs("qwen3.8-27b dflash2 mtp nonsense"), { target: "qwen3.8-27b", methods: ["dflash2", "mtp"], draft: undefined });
  assert.deepEqual(parsePullArgs("a/b dspark --draft c/d"), { target: "a/b", methods: ["dspark"], draft: "c/d" });
  assert.equal(parsePullArgs(""), undefined);
});

function fakePi(bins?: string) {
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
      if (cmd.endsWith("uv") && bins) for (const b of ["hf", "mlx_vlm.server", "mlx_vlm.convert"]) writeFileSync(join(bins, b), "");
      if (cmd.endsWith("mlx_vlm.convert")) {
        const out = args[args.indexOf("--mlx-path") + 1];
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "config.json"), JSON.stringify({ block_size: 16 }));
      }
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
    setModel: async () => true,
  };
  const ctx = (model?: { provider: string; id: string }, hasUI = true, ui: { confirm?: boolean; select?: (t: string, o: string[]) => string | undefined } = {}) => ({
    model,
    hasUI,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => {}, confirm: async () => ui.confirm ?? true, select: async (t: string, o: string[]) => ui.select?.(t, o) },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
  });
  return { pi, handlers, providers, commands, execs, notes, ctx };
}

const printed = async (fn: () => Promise<unknown>) => {
  const log = console.log;
  const out: string[] = [];
  console.log = (m: string) => out.push(m);
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return out.join("\n");
};

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
  const ids = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "mlx-vlm.json"), "utf8")).models.map((m: any) => m.id);
  assert.deepEqual(ids.sort(), ["qwen3.5-9b", "qwen3.5-9b@mtp"], "re-pull replaces the same target+method under the easy name");
  const last = f.providers.at(-1)![1];
  assert.ok(last.models.some((m: any) => m.id === "qwen3.5-9b@mtp"));
});

test("/mlx status and unload talk to the server", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  await f.commands.mlx.handler("status", f.ctx());
  assert.match(f.notes.join("\n"), /127\.0\.0\.1/);
  await f.commands.mlx.handler("unload", f.ctx());
  assert.match(f.notes.at(-1)!, /unload/i);
});

test("a port that accepts but stalls is treated as a busy mlx-vlm, so no second server starts", async () => {
  const hung = createServer(() => {});
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-hung-"));
  writeFileSync(join(dir, "mlx-vlm.json"), JSON.stringify({ models: [{ id: Q35, target: Q35, draft: null, kind: null, family: "qwen3.5" }] }));
  const env = { PI_MLX_PORT: process.env.PI_MLX_PORT!, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR! };
  try {
    Object.assign(process.env, { PI_MLX_PORT: String((hung.address() as AddressInfo).port), PI_CODING_AGENT_DIR: dir });
    const url = "../src/index.ts?hung";
    const f = fakePi();
    (await import(url)).default(f.pi as any);
    await f.handlers.session_start({}, f.ctx());
    assert.deepEqual(f.notes, []);
  } finally {
    Object.assign(process.env, env);
    hung.closeAllConnections();
    hung.close();
  }
});

test("a port held by another app: mlx-vlm moves to a free port at session start and remembers it; a pinned PI_MLX_PORT says so", async () => {
  const other = createServer((_, res) => ((res.statusCode = 404), res.end("not mlx-vlm")));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const busy = (other.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "pi-mlx-port-"));
  mkdirSync(join(dir, "mlx-vlm"));
  writeFileSync(join(dir, "mlx-vlm", "port"), String(busy));
  writeFileSync(join(dir, "mlx-vlm.json"), JSON.stringify({ models: [{ id: Q35, target: Q35, draft: null, kind: null, family: "qwen3.5" }] }));
  const env = { PI_MLX_PORT: process.env.PI_MLX_PORT!, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR! };
  const fresh = async (tag: string) => {
    const url = `../src/index.ts?${tag}`;
    const f = fakePi();
    (await import(url)).default(f.pi as any);
    return f;
  };
  try {
    delete process.env.PI_MLX_PORT;
    process.env.PI_CODING_AGENT_DIR = dir;
    const f = await fresh("moved");
    assert.equal(f.providers[0][1].baseUrl, `http://127.0.0.1:${busy}/v1`);
    await f.handlers.session_start({}, f.ctx());
    const moved = Number(readFileSync(join(dir, "mlx-vlm", "port"), "utf8"));
    assert.ok(moved > 0 && moved !== busy);
    assert.equal(f.providers.at(-1)![1].baseUrl, `http://127.0.0.1:${moved}/v1`);
    assert.match(f.notes.join("\n"), new RegExp(`port ${busy} is used by another app.*now uses port ${moved}`));
    assert.equal((await fresh("again")).providers[0][1].baseUrl, `http://127.0.0.1:${moved}/v1`);
    process.env.PI_MLX_PORT = String(busy);
    const pinned = await fresh("pinned");
    await pinned.handlers.session_start({}, pinned.ctx());
    assert.match(pinned.notes.join("\n"), /PI_MLX_PORT/);
    assert.equal(Number(readFileSync(join(dir, "mlx-vlm", "port"), "utf8")), moved);
  } finally {
    Object.assign(process.env, env);
    other.close();
  }
});

test("/mlx model without UI lists installed models first, then the catalog by easy name with drafters and size", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  const lines = (await printed(() => f.commands.mlx.handler("model", f.ctx(undefined, false)))).split("\n");
  const line = (n: string) => lines.find((l) => l.startsWith(`${n} `))!;
  assert.match(lines[0], /^qwen3\.5-9b .*MTP.*✓ installed/);
  assert.equal(lines.filter((l) => l.startsWith("qwen3.5-9b ")).length, 1);
  assert.match(line("qwen3.8-27b"), /DFlash2 \+ MTP +16 GB/);
  assert.match(line("lfm2.5-2.6b"), /DSpark/);
  assert.match(line("lfm3-1.7b"), /no drafter/);
  assert.doesNotMatch(line("gemma4-e4b"), /installed/);
});

test("/mlx model: Enter on a model pulls it once with its drafters, then just switches to the fastest entry", async () => {
  const f = fakePi();
  mod.default(f.pi as any);
  const pick = { select: (_: string, o: string[]) => o.find((l) => l.startsWith("qwen3.8-27b-8bit ")) };
  await f.commands.mlx.handler("model", f.ctx(undefined, true, pick));
  assert.ok(f.execs.some((e) => e.slice(1).join(" ") === `download ${Q38}`), JSON.stringify(f.execs));
  assert.match(f.notes.at(-1)!, /Now using mlx\/qwen3\.8-27b-8bit@dflash2/);
  const pulls = f.execs.length;
  await f.commands.mlx.handler("model", f.ctx(undefined, true, pick));
  assert.equal(f.execs.length, pulls);
  assert.match(f.notes.at(-1)!, /Now using/);
});

test("/mlx pull installs mlx-vlm with uv only after asking, then pulls and tunes the DFlash block", async () => {
  const bins = mkdtempSync(join(tmpdir(), "bin-"));
  writeFileSync(join(bins, "uv"), "");
  const env = { HOME: process.env.HOME, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: bins, PATH: bins });
  try {
    const no = fakePi(bins);
    mod.default(no.pi as any);
    await no.commands.mlx.handler(`pull ${Q35} dflash`, no.ctx(undefined, true, { confirm: false }));
    assert.deepEqual(no.execs, []);
    const yes = fakePi(bins);
    mod.default(yes.pi as any);
    await yes.commands.mlx.handler(`pull ${Q35} dflash`, yes.ctx());
    assert.deepEqual(yes.execs.map((e) => e.slice(1, 4).join(" ")).slice(0, 2), ["tool install mlx-vlm", "tool install huggingface_hub"]);
    assert.ok(yes.execs.some((e) => e[0] === join(bins, "mlx_vlm.convert")));
  } finally {
    Object.assign(process.env, env);
  }
  const drafter = join(process.env.PI_CODING_AGENT_DIR!, "mlx-vlm", "drafters", "Qwen3.5-9B-DFlash-4bit", "config.json");
  assert.equal(JSON.parse(readFileSync(drafter, "utf8")).block_size, 4);
});
