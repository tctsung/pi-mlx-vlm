// Renders bench/results.json into two diagram-design bar charts (decode tok/s, Pi task seconds) as HTML + SVG in docs/, and rewrites the README speed section with a summary table.
import { readFileSync, writeFileSync } from "node:fs";

const C = { paper: "#f5f5f5", ink: "#2d3142", muted: "#4f5d75", accent: "#bf4520", series: "#7c8f6f" };
const MONO = "'Geist Mono', ui-monospace, monospace";
const SANS = "'Geist', system-ui, sans-serif";
const tint = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const results = JSON.parse(readFileSync(process.argv[2] ?? "bench/results.json", "utf8"));
const ORDER = ["Ollama (MLX)", "mlx-vlm", "mlx-vlm + MTP", "mlx-vlm + DFlash"];

type Series = { name: string; color: string; values: number[] };
function chart(slug: string, title: string, desc: string, axis: string, cats: string[], series: Series[], focal: number | undefined, fmt: (v: number) => string) {
  const max = Math.max(...series.flatMap((s) => s.values));
  const step = [5, 10, 20, 25, 50, 100, 200].find((s) => (max * 1.15) / s <= 6)!;
  const top = Math.ceil((max * 1.15) / step) * step;
  const y = (v: number) => Math.round(420 - (v / top) * 380);
  const pitch = 880 / cats.length;
  const bw = series.length === 1 ? 104 : 72;
  const gap = 8;
  const group = series.length * bw + (series.length - 1) * gap;
  const out: string[] = [];
  for (let t = step; t <= top; t += step) {
    out.push(`<line x1="80" y1="${y(t)}" x2="960" y2="${y(t)}" stroke="${tint(C.ink, 0.08)}" stroke-width="0.8"/>`);
    out.push(`<text x="72" y="${y(t) + 4}" fill="${C.muted}" font-size="8" font-family="${MONO}" text-anchor="end">${t}</text>`);
  }
  out.push(`<line x1="80" y1="40" x2="80" y2="420" stroke="${tint(C.ink, 0.25)}" stroke-width="1"/>`, `<line x1="80" y1="420" x2="960" y2="420" stroke="${tint(C.ink, 0.25)}" stroke-width="1"/>`);
  out.push(`<text transform="rotate(-90 24 230)" x="24" y="230" fill="${C.muted}" font-size="7" font-family="${MONO}" letter-spacing="0.14em" text-anchor="middle">${axis}</text>`);
  cats.forEach((cat, i) => {
    const x0 = Math.round(80 + i * pitch + (pitch - group) / 2);
    series.forEach((s, j) => {
      const v = s.values[i];
      const x = x0 + j * (bw + gap);
      const hot = series.length > 1 ? s.color === C.accent : i === focal;
      const stroke = series.length > 1 ? s.color : hot ? C.accent : C.muted;
      out.push(`<rect x="${x}" y="${y(v)}" width="${bw}" height="${420 - y(v)}" fill="${C.paper}"/>`);
      out.push(`<rect x="${x}" y="${y(v)}" width="${bw}" height="${420 - y(v)}" fill="${tint(stroke, hot ? 0.12 : 0.15)}" stroke="${stroke}" stroke-width="1"/>`);
      out.push(`<text x="${x + bw / 2}" y="${y(v) - 8}" fill="${hot && series.length === 1 ? C.accent : C.muted}" font-size="8" font-family="${MONO}" text-anchor="middle"${hot && series.length === 1 ? ' font-weight="600"' : ""}>${fmt(v)}</text>`);
    });
    out.push(`<text x="${Math.round(80 + i * pitch + pitch / 2)}" y="440" fill="${i === focal && series.length === 1 ? C.accent : C.ink}" font-size="11" font-weight="600" font-family="${SANS}" text-anchor="middle">${cat}</text>`);
  });
  out.push(`<line x1="40" y1="462" x2="960" y2="462" stroke="${tint(C.ink, 0.1)}" stroke-width="0.8"/>`);
  out.push(`<text x="40" y="478" fill="${C.muted}" font-size="8" font-family="${MONO}" letter-spacing="0.18em">LEGEND</text>`);
  series.forEach((s, j) => {
    const x = 40 + j * 200;
    out.push(`<rect x="${x}" y="488" width="16" height="10" rx="2" fill="${tint(s.color, 0.12)}" stroke="${s.color}" stroke-width="1"/>`);
    out.push(`<text x="${x + 24}" y="497" fill="${C.muted}" font-size="8.5" font-family="${SANS}">${s.name}</text>`);
  });
  out.push(`<text x="960" y="497" fill="${C.muted}" font-size="8" font-family="${MONO}" text-anchor="end">${results.machine} · ${results.mlx.split("/")[1]} vs ollama ${results.ollama}</text>`);
  const svg = `<svg viewBox="0 0 1000 500" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${slug}-title ${slug}-desc">
  <title id="${slug}-title">${title}</title>
  <desc id="${slug}-desc">${desc}</desc>
  <defs><pattern id="${slug}-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.9" fill="${tint(C.ink, 0.1)}"/></pattern></defs>
  <rect width="100%" height="100%" fill="${C.paper}"/>
  <rect width="100%" height="100%" fill="url(#${slug}-dots)" opacity="0.55"/>
  ${out.join("\n  ")}
</svg>`;
  writeFileSync(`docs/${slug}.svg`, svg + "\n");
  writeFileSync(`docs/${slug}.html`, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ${SANS}; background: ${C.paper}; color: ${C.ink}; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 3rem 2rem; }
    .frame { max-width: 1200px; width: 100%; }
    .eyebrow { font-family: ${MONO}; font-size: 0.66rem; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; color: ${C.muted}; margin-bottom: 0.5rem; }
    h1 { font-family: 'Instrument Serif', serif; font-size: clamp(1.5rem, 2.4vw + 0.75rem, 2rem); font-weight: 400; letter-spacing: -0.02em; line-height: 1.15; margin-bottom: 1.5rem; }
    .scroll { overflow-x: auto; }
    svg { width: 100%; min-width: 1000px; display: block; }
  </style>
</head>
<body>
  <div class="frame">
    <p class="eyebrow">Bar · pi-mlx-vlm benchmark</p>
    <h1>${title}</h1>
    <div class="scroll">
    ${svg}
    </div>
  </div>
</body>
</html>
`);
}

for (const d of results.decode) d.thinking ??= "off";
const labels = ORDER.filter((l) => results.decode.some((d: any) => d.label === l));
const levels: string[] = [...new Set<string>(results.tasks.map((t: any) => t.thinking))];
const NAMES: Record<string, string> = { off: "Thinking off", medium: "Thinking on" };
const pick = (rows: any[], label: string, lv: string, key: string) => {
  const row = rows.find((r) => r.label === label && r.thinking === lv);
  return row ? mean(row.runs.map((r: any) => r[key])) : 0;
};
const grouped = (rows: any[], key: string, hint: string) =>
  levels.map((lv, j) => ({
    name: `${NAMES[lv] ?? lv} · ${hint}`,
    color: levels.length === 1 ? C.muted : j === levels.length - 1 ? C.accent : C.series,
    values: labels.map((l) => pick(rows, l, lv, key)),
  }));
const decode = grouped(results.decode, "tps", "higher is better");
const tasks = grouped(results.tasks, "secs", "lower is better");
const solo = (s: Series[], f: (...v: number[]) => number) => (s.length === 1 ? s[0].values.indexOf(f(...s[0].values)) : undefined);
const n = (rows: any[]) => rows[0].runs.length;
chart("speed-decode", "Decode speed, tokens per second", `Mean streamed decode speed per engine and thinking level over ${n(results.decode)} sampled 512-token generations; higher is better.`, "TOKENS / SECOND", labels, decode, solo(decode, Math.max), (v) => v.toFixed(1));
chart("speed-task", "Pi agent task, seconds end to end", `Mean wall time for one Pi coding task (write fib.py plus unittest, run tests) per engine and thinking level over ${n(results.tasks)} runs; lower is better.`, "SECONDS", labels, tasks, solo(tasks, Math.min), (v) => `${v.toFixed(0)}s`);

const rows = labels.map((l, i) => {
  const d = decode.map((s) => `${s.values[i].toFixed(1)} (${(s.values[i] / s.values[0]).toFixed(2)}×)`);
  const t = tasks.map((s) => `${s.values[i].toFixed(0)} s`);
  const runs = results.tasks.filter((r: any) => r.label === l).flatMap((r: any) => r.runs);
  return `| ${l} | ${[...d, ...t].join(" | ")} | ${runs.filter((r: any) => r.ok).length}/${runs.length} |`;
});
const heads = [...levels.map((lv) => `Decode tok/s, ${(NAMES[lv] ?? lv).toLowerCase()}`), ...levels.map((lv) => `Pi task, ${(NAMES[lv] ?? lv).toLowerCase()}`)];
const section = `<!-- bench:start -->
![Decode speed](docs/speed-decode.svg)

![Pi agent task time](docs/speed-task.svg)

| Engine | ${heads.join(" | ")} | Task tests passed |
|---|${heads.map(() => "---|").join("")}---|
${rows.join("\n")}

${results.machine}, \`${results.mlx}\` on mlx-vlm vs \`${results.ollama}\` on Ollama, ${results.date.slice(0, 10)}. Decode: mean of ${n(results.decode)} streamed 512-token generations (3 prompts) with Qwen's sampling for each mode; × is relative to Ollama. Pi task: \`${results.task}\`, mean of ${n(results.tasks)} runs of \`pi -p\` with prefix caching on for both engines. Raw numbers in [bench/results.json](bench/results.json).
<!-- bench:end -->`;
const readme = readFileSync("README.md", "utf8");
writeFileSync("README.md", readme.replace(/<!-- bench:start -->[\s\S]*<!-- bench:end -->/, section));
