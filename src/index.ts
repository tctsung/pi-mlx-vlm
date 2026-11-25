// pi-mlx-vlm: "mlx" Pi provider backed by one local mlx-vlm server on 127.0.0.1 (moves to a free port if another app holds it); models come from catalog.json by easy name or any repo, each pulled model+drafter pairing is a /model entry, the drafter is switched at runtime before each request, and /mlx model|pull|status|unload manage it.
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PULLED = join(AGENT_DIR, "mlx-vlm.json");
const HOME = join(AGENT_DIR, "mlx-vlm");
const LOG = join(HOME, "server.log");
const PORT_FILE = join(HOME, "port");
const saved = () => (existsSync(PORT_FILE) ? Number(readFileSync(PORT_FILE, "utf8")) || 0 : 0);
let port = Number(process.env.PI_MLX_PORT) || saved() || 8080;
const server = () => `http://${HOST}:${port}`;
export const WATCHDOG = fileURLToPath(new URL("./keepalive.mjs", import.meta.url));

export const METHODS = ["dflash2", "dflash", "dspark", "mtp"] as const;
type Method = (typeof METHODS)[number];
const LABEL: Record<string, string> = { dflash2: "DFlash2", dflash: "DFlash", dspark: "DSpark", mtp: "MTP" };
type ChatModel = Extract<ProviderModelConfig, { reasoning: boolean }> & { samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>> };
export type Entry = { id: string; target: string; draft: string | null; kind: "mtp" | "dflash" | null; family: string };
type Known = { repo: string; family?: string; gb?: number; block?: number } & Partial<Record<Method, string>>;

export const CATALOG: Record<string, Known> = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
export const known = (t: string) => Object.entries(CATALOG).find(([name, k]) => name === t || k.repo === t);
const method = (id: string) => id.split("@")[1] ?? "";
const methods = (k?: Known) => METHODS.filter((m) => k?.[m]);

const QWEN = { input: ["text", "image"], contextWindow: 262144 } satisfies Partial<ChatModel>;
const ON_OFF = { off: "none", minimal: null, low: null, medium: "medium", high: null };
const FAMILIES: Record<string, Pick<ChatModel, "input" | "contextWindow" | "thinkingLevelMap"> & Partial<ChatModel>> = {
  "qwen3.8": {
    ...QWEN,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "xhigh" },
    samplingParams: { temperature: 1, top_p: 0.95, top_k: 20 },
  },
  "qwen3.5": {
    ...QWEN,
    thinkingLevelMap: ON_OFF,
    samplingParams: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5 },
    samplingParamsByThinkingLevel: { off: { temperature: 0.7, top_p: 0.8 } },
  },
  gemma4: { input: ["text", "image"], contextWindow: 131072, thinkingLevelMap: ON_OFF, samplingParams: { temperature: 1, top_p: 0.95, top_k: 64 } },
  "lfm3-vl": { input: ["text", "image"], contextWindow: 32768, thinkingLevelMap: ON_OFF },
  default: { input: ["text"], contextWindow: 32768, thinkingLevelMap: ON_OFF },
};

export const toModels = (entries: Entry[]): ChatModel[] =>
  entries.map((e) => ({
    id: e.id,
    name: `${basename(e.id.split("@")[0])} ${LABEL[method(e.id)] ?? "no drafter"}`,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 32768,
    compat: { thinkingFormat: "openai", supportsReasoningEffort: true, supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
    ...(FAMILIES[e.family] ?? FAMILIES.default),
  }));

export function planPull(name: string, wanted: Method[], draft: string | undefined, drafters = join(HOME, "drafters")) {
  const [easy, k] = known(name) ?? [name];
  const target = k?.repo ?? name;
  const family = k?.family ?? "default";
  const steps: [string, string[]][] = [["hf", ["download", target]]];
  const entries: Entry[] = [{ id: easy, target, draft: null, kind: null, family }];
  const warnings: string[] = [];
  let block: { path: string; size: number } | undefined;
  if (!k && !wanted.length) warnings.push(`${target} is not in the catalog, so only the plain model is added. For a drafter: /mlx pull ${target} <${METHODS.join("|")}> --draft <repo>`);
  for (const m of wanted.length ? wanted : methods(k)) {
    const repo = draft ?? k?.[m];
    if (!repo) {
      warnings.push(`No known ${LABEL[m]} drafter for ${easy}; pass --draft <repo>`);
      continue;
    }
    const convert = m === "dflash" || m === "dflash2";
    const path = convert ? join(drafters, `${basename(repo)}-4bit`) : repo;
    if (!convert) steps.push(["hf", ["download", repo]]);
    else if (!existsSync(path)) steps.push(["mlx_vlm.convert", ["--hf-path", repo, "--mlx-path", path, "--quantize", "--q-bits", "4", "--q-group-size", "64"]]);
    if (convert && !draft && k?.block) block = { path, size: k.block };
    entries.push({ id: `${easy}@${m}`, target, draft: path, kind: m === "mtp" ? "mtp" : "dflash", family });
  }
  return { steps, entries, warnings, block };
}

export function setBlock(dir: string, size: number) {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), block_size: size }, null, 2));
}

export function parsePullArgs(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const at = words.indexOf("--draft");
  const draft = at >= 0 ? words.splice(at, 2)[1] : undefined;
  const [target, ...rest] = words;
  if (!target) return undefined;
  return { target, methods: rest.filter((w): w is Method => (METHODS as readonly string[]).includes(w)), draft };
}

export const serverArgs = () => ["--host", HOST, "--port", String(port)];
export const SERVER_ENV = { APC_ENABLED: "1", APC_DISK_ENABLED: "0", MLX_VLM_MAX_NUM_SEQS: "1" };
export const keepAlive = (v = process.env.PI_MLX_KEEP_ALIVE) => {
  const m = /^(-?\d+)([smh]?)$/.exec(v?.trim() ?? "");
  return m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600 }[m[2] as "" | "s" | "m" | "h"] : 300;
};

const bin = (name: string) =>
  [join(homedir(), ".local", "bin"), ...(process.env.PATH ?? "").split(":")].map((d) => join(d, name)).find((p) => existsSync(p));

const load = (): Entry[] => (existsSync(PULLED) ? JSON.parse(readFileSync(PULLED, "utf8")).models : []);

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(server() + path, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(init.method ? 60_000 : 3_000) });
  if (!res.ok) throw new Error(`mlx-vlm ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

const say = (ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(msg, type) : console.log(msg));
const up = () => api("/health").then(() => true, () => false);
const USAGE = "/mlx model | pull <name|repo> [mtp|dflash|dflash2|dspark] [--draft <repo>] | status | unload";

const bindable = (p: number) =>
  new Promise<number>((done) => {
    const s = createServer().once("error", () => done(0));
    s.listen(p, HOST, () => {
      const got = (s.address() as AddressInfo).port;
      s.close(() => done(got));
    });
  });

async function probe(p = port) {
  const res = await fetch(`http://${HOST}:${p}/health`, { signal: AbortSignal.timeout(3_000) }).catch((err: Error) => err);
  if (res instanceof Error) return res.name === "TimeoutError" ? "mlx" : (await bindable(p)) ? "free" : "other";
  return (await res.json().catch(() => null))?.loaded_model !== undefined ? "mlx" : "other";
}

async function ensureDraft(e: Entry) {
  const { current } = await api("/v1/settings");
  if ((current.draft_model ?? null) === e.draft && (current.draft_kind ?? null) === e.kind) return;
  await api("/v1/settings", { method: "PATCH", body: JSON.stringify({ draft_model: e.draft, draft_kind: e.kind }) });
}

export default function (pi: ExtensionAPI) {
  const register = () =>
    pi.registerProvider("mlx", { name: "MLX (mlx-vlm)", baseUrl: `${server()}/v1`, apiKey: "local", api: "openai-completions", models: toModels(load()) });

  async function movePort(ctx: ExtensionContext) {
    if (process.env.PI_MLX_PORT) throw new Error(`port ${port} (PI_MLX_PORT) is used by another app. Unset PI_MLX_PORT to pick a free port automatically`);
    const old = port;
    const last = saved();
    port = last && last !== port && (await probe(last)) === "mlx" ? last : await bindable(0);
    mkdirSync(HOME, { recursive: true });
    writeFileSync(PORT_FILE, String(port));
    register();
    say(ctx, `mlx: port ${old} is used by another app, so mlx-vlm now uses port ${port} (saved in ${PORT_FILE}).`, "warning");
  }

  async function ensureServer(ctx: ExtensionContext) {
    let state = await probe();
    if (state === "other") {
      await movePort(ctx);
      state = await probe();
    }
    if (state === "mlx") return;
    const exe = bin("mlx_vlm.server");
    if (!exe) throw new Error("mlx_vlm.server not found. Run /mlx model");
    mkdirSync(HOME, { recursive: true });
    const log = openSync(LOG, "a");
    ctx.ui.setStatus("mlx", "mlx: starting server");
    const child = spawn(exe, serverArgs(), { detached: true, stdio: ["ignore", log, log], env: { ...SERVER_ENV, ...process.env } }).on("error", () => {});
    child.unref();
    const idle = keepAlive();
    if (child.pid && idle >= 0) spawn(process.execPath, [WATCHDOG, server(), String(child.pid), String(idle)], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
    closeSync(log);
    try {
      for (let i = 0; i < 240 && child.exitCode === null; i++) {
        if (await up()) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`mlx-vlm server did not start on port ${port}; see ${LOG}`);
    } finally {
      ctx.ui.setStatus("mlx", undefined);
    }
  }

  async function run(ctx: ExtensionContext, cmd: string, args: string[]) {
    const exe = bin(cmd);
    if (!exe) throw new Error(`${cmd} not found. Run /mlx model`);
    ctx.ui.setStatus("mlx", `mlx: ${cmd} ${args[1] ?? args[0]}`);
    const res = await pi.exec(exe, args).finally(() => ctx.ui.setStatus("mlx", undefined));
    if (res.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${(res.stderr || res.stdout).slice(-800)}`);
  }

  async function ensureTools(ctx: ExtensionContext) {
    if (bin("mlx_vlm.server") && bin("hf")) return true;
    const install = "uv tool install mlx-vlm && uv tool install huggingface_hub";
    if (!bin("uv")) throw new Error("uv not found. Install uv (brew install uv), then retry");
    if (!ctx.hasUI) throw new Error(`mlx-vlm is not installed. Run: ${install}`);
    if (!(await ctx.ui.confirm("Install mlx-vlm?", `Runs: ${install}`))) return false;
    for (const pkg of ["mlx-vlm", "huggingface_hub"]) await run(ctx, "uv", ["tool", "install", pkg]);
    return true;
  }

  const commands: Record<string, (args: string, ctx: ExtensionContext) => Promise<unknown>> = {
    async pull(args, ctx) {
      const p = parsePullArgs(args);
      if (!p) return say(ctx, `usage: ${USAGE}`, "warning");
      if (!(await ensureTools(ctx))) return;
      const plan = planPull(p.target, p.methods, p.draft);
      for (const w of plan.warnings) say(ctx, w, "warning");
      for (const [cmd, a] of plan.steps) await run(ctx, cmd, a);
      if (plan.block) setBlock(plan.block.path, plan.block.size);
      mkdirSync(AGENT_DIR, { recursive: true });
      const same = (a: Entry, b: Entry) => a.target === b.target && method(a.id) === method(b.id);
      writeFileSync(PULLED, JSON.stringify({ models: [...load().filter((m) => !plan.entries.some((e) => same(e, m))), ...plan.entries] }, null, 2));
      register();
      say(ctx, `Added ${plan.entries.map((e) => `mlx/${e.id}`).join(", ")}. Switch with /model.`);
    },
    async model(_, ctx) {
      const pulled = load();
      const easy = (t: string) => known(t)?.[0] ?? t;
      const rows = new Map<string, [string[], string]>();
      for (const t of new Set(pulled.map((m) => m.target))) rows.set(easy(t), [pulled.filter((m) => m.target === t && m.draft).map((m) => LABEL[method(m.id)]), "✓ installed"]);
      for (const [name, k] of Object.entries(CATALOG)) if (!rows.has(name)) rows.set(name, [methods(k).map((m) => LABEL[m]), `${k.gb} GB`]);
      const width = Math.max(...[...rows.keys()].map((n) => n.length));
      const labels = [...rows].map(([n, [drafts, note]]) => `${n.padEnd(width)}  ${(drafts.join(" + ") || "no drafter").padEnd(15)}  ${note}`);
      if (!ctx.hasUI) return say(ctx, [...labels, "Pick one with /mlx model in Pi, or run /mlx pull <name|repo>."].join("\n"));
      const name = [...rows.keys()][labels.indexOf((await ctx.ui.select("MLX models: Enter pulls or switches", labels)) ?? "")];
      if (!name) return;
      const target = known(name)?.[1].repo ?? name;
      if (!pulled.some((m) => m.target === target)) await commands.pull(name, ctx);
      const order = [...METHODS, ""];
      const rank = (e: Entry) => order.indexOf(method(e.id) as Method);
      const best = load().filter((m) => m.target === target).sort((a, b) => rank(a) - rank(b))[0];
      if (!best) return;
      await ensureServer(ctx);
      const model = ctx.modelRegistry.find("mlx", best.id);
      if (model && (await pi.setModel(model))) say(ctx, `Now using mlx/${model.id}. Ctrl+S in /model makes it the default.`);
    },
    async status(_, ctx) {
      const health = await api("/health").catch(() => undefined);
      const draft = health && (await api("/v1/settings")).current;
      say(ctx, [
        `server ${server()}: ${health ? `up, loaded ${health.loaded_model ?? "nothing"}` : "down (starts on the first mlx request)"}`,
        draft ? `drafter: ${draft.draft_model ?? "none"} (${draft.draft_kind ?? "-"})` : "",
        `models: ${load().map((m) => `mlx/${m.id}`).join(", ") || "none, run /mlx model"}`,
      ].filter(Boolean).join("\n"));
    },
    async unload(_, ctx) {
      const res = await api("/unload", { method: "POST" }).catch(() => undefined);
      say(ctx, res ? `mlx-vlm unload: ${res.status}` : "mlx-vlm server is not running");
    },
  };

  register();

  pi.registerCommand("mlx", {
    description: `mlx-vlm: ${USAGE}`,
    getArgumentCompletions: (prefix: string) => {
      const items = Object.keys(commands).filter((c) => c.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      const cmd = commands[sub];
      if (!cmd) return say(ctx, `usage: ${USAGE}`);
      await cmd(rest.join(" "), ctx).catch((err: Error) => say(ctx, `mlx: ${err.message}`, "error"));
    },
  });

  pi.on("session_start", async (_, ctx) => {
    if (load().length && (await probe()) === "other") await movePort(ctx).catch((err: Error) => say(ctx, `mlx: ${err.message}`, "error"));
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (ctx.model?.provider !== "mlx") return;
    const entry = load().find((m) => m.id === ctx.model!.id);
    if (!entry) return;
    const was = port;
    try {
      await ensureServer(ctx);
      await ensureDraft(entry);
    } catch (err) {
      say(ctx, `mlx: ${(err as Error).message}`, "error");
    }
    if (port !== was) say(ctx, "mlx: this message went to the old port. Send it again.", "warning");
    return { ...(event.payload as object), model: entry.target };
  });
}
