// Shared by the Pi extension and the pi-mlx CLI: paths, the catalog of easy model names, pull plans into the permanent models folder, and the pulled-models file Pi reads.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const PULLED = join(AGENT_DIR, "mlx-vlm.json");
export const HOME = join(AGENT_DIR, "mlx-vlm");
export const MODELS = process.env.PI_MLX_MODELS ?? join(HOME, "models");
export const METHODS = ["dflash2", "dflash", "dspark", "mtp"];
export const LABEL = { dflash2: "DFlash2", dflash: "DFlash", dspark: "DSpark", mtp: "MTP" };

export const CATALOG = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
export const known = (t) => Object.entries(CATALOG).find(([name, k]) => name === t || k.repo === t);
export const method = (id) => id.split("@")[1] ?? "";
export const methods = (k) => METHODS.filter((m) => k?.[m]);
export const rank = (id) => [...METHODS, ""].indexOf(method(id));
export const load = () => (existsSync(PULLED) ? JSON.parse(readFileSync(PULLED, "utf8")).models : []);
export const bin = (name) => [join(homedir(), ".local", "bin"), ...(process.env.PATH ?? "").split(":")].map((d) => join(d, name)).find((p) => existsSync(p));

export function planPull(name, wanted, draft, models = MODELS) {
  const [easy, k] = known(name) ?? [name, undefined];
  const target = k?.repo ?? name;
  const family = k?.family ?? "default";
  const path = join(models, target);
  const steps = [{ label: `${target}${k?.gb ? `, ${k.gb} GB` : ""}`, cmd: "hf", args: ["download", target, "--local-dir", path] }];
  const entries = [{ id: easy, target, path, draft: null, kind: null, family }];
  const warnings = [];
  const cleanup = [];
  let block;
  if (!k && !wanted.length) warnings.push(`${target} is not in the catalog, so only the plain model is added. For a drafter: pi-mlx pull ${target} <${METHODS.join("|")}> --draft <repo>`);
  for (const m of wanted.length ? wanted : methods(k)) {
    const repo = draft ?? k?.[m];
    if (!repo) {
      warnings.push(`No known ${LABEL[m]} drafter for ${easy}; pass --draft <repo>`);
      continue;
    }
    const convert = m === "dflash" || m === "dflash2";
    const out = join(models, convert ? `${repo}-4bit` : repo);
    if (!convert) steps.push({ label: `${LABEL[m]} drafter ${repo}`, cmd: "hf", args: ["download", repo, "--local-dir", out] });
    else if (!existsSync(out)) {
      const src = join(tmpdir(), "pi-mlx", basename(repo));
      steps.push({ label: `${LABEL[m]} drafter ${repo}`, cmd: "hf", args: ["download", repo, "--local-dir", src] });
      steps.push({ label: `${LABEL[m]} drafter to 4-bit`, cmd: "mlx_vlm.convert", args: ["--hf-path", src, "--mlx-path", out, "--quantize", "--q-bits", "4", "--q-group-size", "64"] });
      cleanup.push(src);
    }
    if (convert && !draft && k?.block) block = { path: out, size: k.block };
    entries.push({ id: `${easy}@${m}`, target, path, draft: out, kind: m === "mtp" ? "mtp" : "dflash", family });
  }
  return { steps, entries, warnings, block, cleanup };
}

export function save(entries) {
  const same = (a, b) => a.target === b.target && method(a.id) === method(b.id);
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(PULLED, JSON.stringify({ models: [...load().filter((m) => !entries.some((e) => same(e, m))), ...entries] }, null, 2));
}

export function setBlock(dir, size) {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), block_size: size }, null, 2));
}

export function parsePullArgs(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const at = words.indexOf("--draft");
  const draft = at >= 0 ? words.splice(at, 2)[1] : undefined;
  const [target, ...rest] = words;
  if (!target) return undefined;
  return { target, methods: rest.filter((w) => METHODS.includes(w)), draft };
}
