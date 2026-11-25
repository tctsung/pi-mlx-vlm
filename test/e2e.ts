// End-to-end check with real Pi, mlx-vlm and Ollama: fresh agent dir, pi install, /mlx model over RPC (confirm install, Enter on the target), chat on @mtp/@dflash, switch to ollama and back without restart, thinking levels, loopback-only listener.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const TARGET = process.env.E2E_TARGET ?? "mlx-community/Qwen3.5-9B-4bit";
const OLLAMA = process.env.E2E_OLLAMA ?? "qwen3.5:9b-mlx";
const PORT = process.env.PI_MLX_PORT ?? "8080";
const repo = join(dirname(new URL(import.meta.url).pathname), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-e2e-agent-"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: OLLAMA, reasoning: true }] } },
}));
execFileSync("pi", ["install", repo], { env, stdio: "inherit" });

const pi = spawn("pi", ["--mode", "rpc", "--no-session"], { env, cwd: mkdtempSync(join(tmpdir(), "pi-e2e-work-")), stdio: ["pipe", "pipe", "inherit"] });
const waiters: { match: (e: any) => boolean; done: (e: any) => void }[] = [];
const notes: string[] = [];
createInterface({ input: pi.stdout! }).on("line", (line) => {
  if (!line.startsWith("{")) return;
  const e = JSON.parse(line);
  if (e.type === "extension_ui_request") {
    if (e.method === "notify") notes.push(e.message), console.log("  notify:", e.message);
    if (e.method === "confirm") send({ type: "extension_ui_response", id: e.id, confirmed: true });
    if (e.method === "select") send({ type: "extension_ui_response", id: e.id, value: e.options.find((o: string) => o.startsWith(`${TARGET} `)) });
  }
  for (const w of [...waiters]) if (w.match(e)) waiters.splice(waiters.indexOf(w), 1), w.done(e);
});
let seq = 0;
const send = (cmd: object) => pi.stdin!.write(JSON.stringify(cmd) + "\n");
const next = (match: (e: any) => boolean, ms = 900_000) =>
  new Promise<any>((done, fail) => {
    waiters.push({ match, done });
    setTimeout(() => fail(new Error("timeout")), ms).unref();
  });
const call = (cmd: object) => {
  const id = `r${++seq}`;
  const res = next((e) => e.type === "response" && e.id === id);
  send({ ...cmd, id });
  return res;
};
const ask = async (message: string) => {
  const t0 = performance.now();
  const end = next((e) => e.type === "agent_end");
  await call({ type: "prompt", message });
  await end;
  const text = (await call({ type: "get_last_assistant_text" })).data?.text ?? "";
  return { text, secs: (performance.now() - t0) / 1000 };
};
const step = (name: string) => console.log(`- ${name}`);

step("/mlx model");
const picked = next((e) => e.type === "extension_ui_request" && e.method === "notify" && /Now using mlx\//.test(e.message));
await call({ type: "prompt", message: "/mlx model" });
await picked;

step("pulled pairings show up as models");
const ids = (await call({ type: "get_available_models" })).data.models.map((m: any) => `${m.provider}/${m.id}`);
for (const id of [`mlx/${TARGET}`, `mlx/${TARGET}@mtp`, `mlx/${TARGET}@dflash`, `ollama/${OLLAMA}`]) assert.ok(ids.includes(id), `${id} missing in ${ids}`);

const settings = async () => (await (await fetch(`http://127.0.0.1:${PORT}/v1/settings`)).json()).current;
for (const [provider, modelId, kind] of [["mlx", `${TARGET}@mtp`, "mtp"], ["ollama", OLLAMA, ""], ["mlx", `${TARGET}@dflash`, "dflash"], ["mlx", TARGET, null]] as const) {
  step(`chat on ${provider}/${modelId}`);
  assert.ok((await call({ type: "set_model", provider, modelId })).success);
  await call({ type: "set_thinking_level", level: "off" });
  const r = await ask("Reply with exactly the word: pong");
  console.log(`  ${r.secs.toFixed(1)}s ${JSON.stringify(r.text.slice(0, 60))}`);
  assert.match(r.text.toLowerCase(), /pong/);
  if (provider === "mlx") assert.equal((await settings()).draft_kind, kind);
}

step("thinking level changes response time");
await call({ type: "set_model", provider: "mlx", modelId: `${TARGET}@mtp` });
const levels = (await call({ type: "get_available_thinking_levels" })).data.levels;
console.log("  levels:", levels.join(", "));
await ask("Reply with exactly the word: warm");
const timed: Record<string, number> = {};
const tried = levels.filter((l: string) => ["off", "low", "medium", "high"].includes(l));
for (const level of tried) {
  await call({ type: "set_thinking_level", level });
  timed[level] = (await ask("Is 391 a prime number? Answer yes or no.")).secs;
  console.log(`  ${level}: ${timed[level].toFixed(1)}s`);
}
assert.ok(timed[tried.at(-1)] > timed.off, "the highest thinking level should take longer than off");

step("server listens on 127.0.0.1 only");
const listen = execFileSync("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
assert.match(listen, new RegExp(`127\\.0\\.0\\.1:${PORT}`));
assert.doesNotMatch(listen, new RegExp(`\\*:${PORT}|0\\.0\\.0\\.0`));

pi.stdin!.end();
await new Promise((done) => pi.on("exit", done));
console.log("e2e ok");
