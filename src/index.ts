// pi-mlx-vlm: "mlx" Pi provider backed by one local mlx-vlm server on 127.0.0.1 (moves to a free port if another app holds it); each model+drafter pairing pulled with the pi-mlx CLI is a /model entry (refreshed live), the drafter is switched at runtime before each request, and /mlx status|unload inspect it.
import type { ExtensionAPI, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, LABEL, PULLED, bin, load as loadAny, method } from "./models.mjs";

const HOST = "127.0.0.1";
const LOG = join(HOME, "server.log");
const PORT_FILE = join(HOME, "port");
const saved = () => (existsSync(PORT_FILE) ? Number(readFileSync(PORT_FILE, "utf8")) || 0 : 0);
let port = Number(process.env.PI_MLX_PORT) || saved() || 8080;
const server = () => `http://${HOST}:${port}`;
export const WATCHDOG = fileURLToPath(new URL("./keepalive.mjs", import.meta.url));

type ChatModel = Extract<ProviderModelConfig, { reasoning: boolean }> & { samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>> };
export type Entry = { id: string; target: string; path?: string; draft: string | null; kind: "mtp" | "dflash" | null; family: string };
const load = (): Entry[] => loadAny();

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
  glimmer: {
    input: ["text", "image"],
    contextWindow: 131072,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    samplingParams: { temperature: 1, top_p: 0.95, top_k: 64 },
  },
  "lfm3-vl": { input: ["text", "image"], contextWindow: 32768, thinkingLevelMap: ON_OFF },
  default: { input: ["text"], contextWindow: 32768, thinkingLevelMap: ON_OFF },
};

export const toModels = (entries: Entry[]): ChatModel[] =>
  entries.map((e) => ({
    id: e.id,
    name: `${basename(e.id.split("@")[0])} ${(LABEL as Record<string, string>)[method(e.id)] ?? "no drafter"}`,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 32768,
    compat: { thinkingFormat: "openai", supportsReasoningEffort: true, supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
    ...(FAMILIES[e.family] ?? FAMILIES.default),
  }));

export const serverArgs = () => ["--host", HOST, "--port", String(port)];
export const SERVER_ENV = { APC_ENABLED: "1", APC_DISK_ENABLED: "0", MLX_VLM_MAX_NUM_SEQS: "1" };
export const keepAlive = (v = process.env.PI_MLX_KEEP_ALIVE) => {
  const m = /^(-?\d+)([smh]?)$/.exec(v?.trim() ?? "");
  return m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600 }[m[2] as "" | "s" | "m" | "h"] : 300;
};

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(server() + path, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(init.method ? 60_000 : 3_000) });
  if (!res.ok) throw new Error(`mlx-vlm ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

const say = (ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(msg, type) : console.log(msg));
const up = () => api("/health").then(() => true, () => false);
const USAGE = "/mlx status | unload. Pull models in a terminal with pi-mlx";

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
    if (!exe) throw new Error("mlx-vlm is not installed. Run pi-mlx pull in a terminal");
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

  const commands: Record<string, (args: string, ctx: ExtensionContext) => Promise<unknown>> = {
    async status(_, ctx) {
      const health = await api("/health").catch(() => undefined);
      const draft = health && (await api("/v1/settings")).current;
      say(ctx, [
        `server ${server()}: ${health ? `up, loaded ${health.loaded_model ?? "nothing"}` : "down (starts on the first mlx request)"}`,
        draft ? `drafter: ${draft.draft_model ?? "none"} (${draft.draft_kind ?? "-"})` : "",
        `models: ${load().map((m) => `mlx/${m.id}`).join(", ") || "none yet. Run pi-mlx pull in a terminal"}`,
      ].filter(Boolean).join("\n"));
    },
    async unload(_, ctx) {
      const res = await api("/unload", { method: "POST" }).catch(() => undefined);
      say(ctx, res ? `mlx-vlm unload: ${res.status}` : "mlx-vlm server is not running");
    },
  };

  register();
  const refresh = () => register();
  watchFile(PULLED, { interval: 2000 }, refresh).unref();
  pi.on("session_shutdown", () => unwatchFile(PULLED, refresh));

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
    return { ...(event.payload as object), model: entry.path ?? entry.target };
  });
}
