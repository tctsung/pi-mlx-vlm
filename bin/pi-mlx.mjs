#!/usr/bin/env node
// pi-mlx: terminal companion of the pi-mlx-vlm Pi extension; pick or pull MLX models with their drafters (live download progress), saved under ~/.pi/agent/mlx-vlm/models, then chat in Pi via /model.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { CATALOG, LABEL, MODELS, PULLED, bin, known, load, method, methods, parsePullArgs, planPull, rank, save, setBlock } from "../src/models.mjs";

const USAGE = `pi-mlx                                   pick a model (arrow keys, Enter pulls it)
pi-mlx pull <name|repo> [mtp|dflash|dflash2|dspark] [--draft <repo>]
pi-mlx list                              pulled models and where they are
pi-mlx rm <name|repo>                    delete a pulled model and its drafters

Models are saved in ${MODELS}. Chat with them in Pi: /model, then mlx/<name>.`;

function run(cmd, args) {
  const exe = bin(cmd);
  if (!exe) throw new Error(`${cmd} not found`);
  if (spawnSync(exe, args, { stdio: "inherit" }).status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [Y/n] `);
  rl.close();
  return !/^n/i.test(answer.trim());
}

function select(title, items) {
  let at = 0;
  const draw = (again) => {
    if (again) process.stdout.write(`\x1b[${items.length}A`);
    for (const [i, item] of items.entries()) process.stdout.write(`\x1b[2K${i === at ? "\x1b[36m❯ " : "  "}${item}\x1b[0m\n`);
  };
  console.log(title);
  process.stdout.write("\x1b[?25l");
  draw(false);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  return new Promise((done) => {
    const onKey = (_, key = {}) => {
      if (key.name === "up" || key.name === "k") at = (at + items.length - 1) % items.length;
      else if (key.name === "down" || key.name === "j") at = (at + 1) % items.length;
      else if (key.name === "return" || key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        process.stdin.off("keypress", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\x1b[?25h");
        return done(key.name === "return" ? at : -1);
      } else return;
      draw(true);
    };
    process.stdin.on("keypress", onKey);
  });
}

async function ensureTools() {
  if (bin("mlx_vlm.server") && bin("hf")) return;
  const install = "uv tool install mlx-vlm && uv tool install huggingface_hub";
  if (!bin("uv")) throw new Error("mlx-vlm needs uv. Install uv (brew install uv), then run pi-mlx again");
  if (!process.stdin.isTTY) throw new Error(`mlx-vlm is not installed. Run: ${install}`);
  if (!(await confirm(`mlx-vlm is not installed. Run "${install}" now?`))) throw new Error("mlx-vlm is needed to pull models");
  for (const pkg of ["mlx-vlm", "huggingface_hub"]) run("uv", ["tool", "install", pkg]);
}

async function pull(text) {
  const p = parsePullArgs(text);
  if (!p) throw new Error(`usage:\n${USAGE}`);
  await ensureTools();
  const plan = planPull(p.target, p.methods, p.draft);
  for (const w of plan.warnings) console.warn(`! ${w}`);
  const drafters = plan.entries.filter((e) => e.draft).map((e) => LABEL[method(e.id)]);
  console.log(`Pulling ${plan.entries[0].id}${drafters.length ? ` with ${drafters.join(" + ")}` : ""} into ${MODELS}`);
  plan.steps.forEach((s, i) => {
    console.log(`\n[${i + 1}/${plan.steps.length}] ${s.label}`);
    run(s.cmd, s.args);
  });
  if (plan.block) setBlock(plan.block.path, plan.block.size);
  for (const dir of plan.cleanup) rmSync(dir, { recursive: true, force: true });
  save(plan.entries);
  const ids = plan.entries.map((e) => e.id).sort((a, b) => rank(a) - rank(b));
  console.log(`\nDone. In Pi, pick it with /model: ${ids.map((id) => `mlx/${id}`).join(", ")} (fastest first).`);
}

function rows() {
  const pulled = load();
  const easy = (t) => known(t)?.[0] ?? t;
  const rows = new Map();
  for (const t of new Set(pulled.map((m) => m.target))) rows.set(easy(t), [pulled.filter((m) => m.target === t && m.draft).map((m) => LABEL[method(m.id)]), "✓ pulled"]);
  for (const [name, k] of Object.entries(CATALOG)) if (!rows.has(name)) rows.set(name, [methods(k).map((m) => LABEL[m]), `${k.gb} GB`]);
  const width = Math.max(...[...rows.keys()].map((n) => n.length));
  return [...rows].map(([name, [drafts, note]]) => [name, `${name.padEnd(width)}  ${(drafts.join(" + ") || "no drafter").padEnd(15)}  ${note}`]);
}

async function pick() {
  const list = rows();
  if (!process.stdin.isTTY) return console.log([...list.map((r) => r[1]), "", "Pull one with: pi-mlx pull <name>"].join("\n"));
  const at = await select("MLX models (↑/↓ move, Enter pulls, q quits; pulled files are not downloaded again)", list.map((r) => r[1]));
  if (at >= 0) await pull(list[at][0]);
}

function list() {
  const pulled = load();
  if (!pulled.length) return console.log("No models pulled yet. Run: pi-mlx");
  for (const m of pulled.sort((a, b) => a.target.localeCompare(b.target) || rank(a.id) - rank(b.id))) console.log(`mlx/${m.id.padEnd(28)} ${m.path ?? `${m.target} (Hugging Face cache)`}`);
}

function rm(name) {
  const target = known(name)?.[1].repo ?? name;
  const pulled = load();
  const gone = pulled.filter((m) => m.target === target);
  if (!gone.length) throw new Error(`${name} is not pulled. See: pi-mlx list`);
  const keep = pulled.filter((m) => m.target !== target);
  const used = new Set(keep.flatMap((m) => [m.path, m.draft]));
  for (const dir of new Set(gone.flatMap((m) => [m.path, m.draft]))) {
    if (!dir?.startsWith(MODELS) || used.has(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    console.log(`deleted ${dir}`);
  }
  writeFileSync(PULLED, JSON.stringify({ models: keep }, null, 2));
  console.log(`Removed ${gone.map((m) => `mlx/${m.id}`).join(", ")}.${gone.some((m) => !m.path) ? ` Older pulls live in the Hugging Face cache: hf cache rm model/${target}` : ""}`);
}

const [cmd = "", ...rest] = process.argv.slice(2);
try {
  if (cmd === "pull") await pull(rest.join(" "));
  else if (cmd === "list" || cmd === "ls") list();
  else if (cmd === "rm" && rest[0]) rm(rest[0]);
  else if (!cmd) await pick();
  else console.log(USAGE);
} catch (err) {
  console.error(`pi-mlx: ${err.message}`);
  process.exitCode = 1;
}
