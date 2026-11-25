// Draws bench/speed.svg from every bench/*.json sample file: mean decode tok/s with thinking off per model and machine, as diagram-design grouped horizontal bars (Ollama, mlx-vlm without a drafter, mlx-vlm with its fastest drafter, plus its speed-up).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { CATALOG } from "../src/models.mjs";

const C = { paper: "#f5f5f5", ink: "#2d3142", muted: "#4f5d75", accent: "#bf4520", ollama: "#7c8f6f" };
const MONO = "'Geist Mono', ui-monospace, monospace";
const SANS = "'Geist', system-ui, sans-serif";
const NAME: Record<string, string> = { ollama: "Ollama", none: "mlx-vlm", mtp: "+ MTP", dflash: "+ DFlash", dflash2: "+ DFlash2", dspark: "+ DSpark" };
const tint = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

type Sample = { machine: string; model: string; config: string; thinking: string; kind: string; tps: number };
const samples: Sample[] = readdirSync("bench").filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(`bench/${f}`, "utf8")));
const decode = samples.filter((s) => s.kind === "decode" && s.thinking === "off");
const by = new Map<string, Map<string, number[]>>();
for (const s of decode) {
  const key = `${s.model}\t${s.machine}`;
  if (!by.has(key)) by.set(key, new Map());
  by.get(key)!.set(s.config, [...(by.get(key)!.get(s.config) ?? []), s.tps]);
}
const order = Object.keys(CATALOG);
const groups = [...by].sort(([a], [b]) => order.indexOf(a.split("\t")[0]) - order.indexOf(b.split("\t")[0]) || a.localeCompare(b)).map(([key, configs]) => {
  const avg = new Map([...configs].map(([c, xs]) => [c, mean(xs)]));
  const best = [...avg].filter(([c]) => c !== "ollama" && c !== "none").sort((a, b) => b[1] - a[1])[0];
  const rows = [["ollama", avg.get("ollama")], ["none", avg.get("none")], best ?? []].filter((r): r is [string, number] => r[1] !== undefined);
  const [model, machine] = key.split("\t");
  return { model, machine, rows, base: avg.get("none"), runs: [...configs.values()].map((xs) => xs.length) };
});
const machines = [...new Set(groups.map((g) => g.machine))];
const runs = groups.flatMap((g) => g.runs);

const W = 800, X0 = 180, X1 = 700, TOP = 56;
const max = Math.max(...groups.flatMap((g) => g.rows.map((r) => r[1])));
const step = [5, 10, 20, 25, 50, 100].find((s) => (max * 1.1) / s <= 6)!;
const ceil = Math.ceil((max * 1.1) / step) * step;
const x = (v: number) => X0 + Math.round((v / ceil) * (X1 - X0));
const out: string[] = [];
let y = TOP;
for (const g of groups) {
  out.push(`<text x="40" y="${y + 12}" fill="${C.ink}" font-size="12" font-weight="600" font-family="${SANS}">${g.model}${machines.length > 1 ? `<tspan fill="${C.muted}" font-size="8" font-weight="500" font-family="${MONO}" letter-spacing="0.18em" dx="8">${g.machine.toUpperCase()}</tspan>` : ""}</text>`);
  y += 20;
  for (const [config, v] of g.rows) {
    const color = config === "ollama" ? C.ollama : config === "none" ? C.muted : C.accent;
    const fill = tint(color, config === "ollama" ? 0.18 : config === "none" ? 0.15 : 0.12);
    const gain = config !== "ollama" && config !== "none" && g.base ? `<tspan fill="${C.accent}" font-weight="600" dx="8">${(v / g.base).toFixed(1)}×</tspan>` : "";
    out.push(`<text x="168" y="${y + 12}" fill="${C.muted}" font-size="11" font-weight="500" font-family="${SANS}" text-anchor="end">${NAME[config] ?? config}</text>`);
    out.push(`<rect x="${X0}" y="${y}" width="${x(v) - X0}" height="16" fill="${C.paper}"/>`);
    out.push(`<rect x="${X0}" y="${y}" width="${x(v) - X0}" height="16" fill="${fill}" stroke="${color}" stroke-width="1"/>`);
    out.push(`<text x="${x(v) + 8}" y="${y + 11}" fill="${C.muted}" font-size="8" font-family="${MONO}">${v.toFixed(1)}${gain}</text>`);
    y += 24;
  }
  y += 12;
}
const bottom = y - 8;
const grid: string[] = [];
for (let t = 0; t <= ceil; t += step) {
  grid.push(t === 0 ? `<line x1="${X0}" y1="${TOP - 8}" x2="${X0}" y2="${bottom}" stroke="${tint(C.ink, 0.25)}" stroke-width="1"/>` : `<line x1="${x(t)}" y1="${TOP - 8}" x2="${x(t)}" y2="${bottom}" stroke="${tint(C.ink, 0.08)}" stroke-width="0.8"/>`);
  grid.push(`<text x="${x(t)}" y="${bottom + 16}" fill="${C.muted}" font-size="8" font-family="${MONO}" text-anchor="middle">${t}</text>`);
}
grid.push(`<text x="${(X0 + X1) / 2}" y="${bottom + 32}" fill="${C.muted}" font-size="7" font-family="${MONO}" letter-spacing="0.14em" text-anchor="middle">TOKENS / SECOND</text>`);
const L = bottom + 48;
const legend = [`<line x1="40" y1="${L}" x2="${W - 40}" y2="${L}" stroke="${tint(C.ink, 0.1)}" stroke-width="0.8"/>`];
[["Ollama", C.ollama, 0.18], ["mlx-vlm, no drafter", C.muted, 0.15], ["mlx-vlm + fastest drafter (× vs no drafter)", C.accent, 0.12]].forEach(([name, color, a], i) => {
  const lx = 40 + [0, 96, 236][i];
  legend.push(`<rect x="${lx}" y="${L + 16}" width="16" height="10" rx="2" fill="${tint(color as string, a as number)}" stroke="${color}" stroke-width="1"/>`);
  legend.push(`<text x="${lx + 24}" y="${L + 25}" fill="${C.muted}" font-size="9" font-family="${SANS}">${name}</text>`);
});
const span = Math.min(...runs) === Math.max(...runs) ? `${runs[0]}` : `${Math.min(...runs)}–${Math.max(...runs)}`;
legend.push(`<text x="${W - 40}" y="${L + 25}" fill="${C.muted}" font-size="8" font-family="${MONO}" text-anchor="end">${machines.length === 1 ? `${machines[0]} · ` : ""}mean of ${span} runs</text>`);
const H = L + 48;

writeFileSync("bench/speed.svg", `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="speed-title speed-desc">
  <title id="speed-title">Decode speed: Ollama vs mlx-vlm with drafters</title>
  <desc id="speed-desc">Mean decode tokens per second with thinking off, per model: Ollama, mlx-vlm without a drafter, and mlx-vlm with its fastest drafter and the speed-up it gives.</desc>
  <rect width="100%" height="100%" fill="${C.paper}"/>
  <text x="40" y="32" fill="${C.muted}" font-size="8" font-weight="500" font-family="${MONO}" letter-spacing="0.18em">DECODE SPEED · THINKING OFF · HIGHER IS BETTER</text>
  ${[...grid, ...out, ...legend].join("\n  ")}
</svg>
`);
console.log(`bench/speed.svg: ${groups.map((g) => `${g.model} ${g.rows.map(([c, v]) => `${c} ${v.toFixed(1)}`).join(", ")}`).join("; ")}`);
