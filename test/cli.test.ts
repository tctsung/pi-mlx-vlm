// Tests for the pi-mlx CLI: runs bin/pi-mlx.mjs against fake hf, mlx_vlm.convert and uv scripts in a temp HOME, PATH and agent dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../bin/pi-mlx.mjs", import.meta.url).pathname;
const FAKES: Record<string, string> = {
  hf: `d=""; prev=""; for a in "$@"; do [ "$prev" = "--local-dir" ] && d="$a"; prev="$a"; done\nmkdir -p "$d" && printf '{"block_size":16}' > "$d/config.json" && echo "fake-progress $2 100%"`,
  "mlx_vlm.convert": `s=""; o=""; prev=""; for a in "$@"; do [ "$prev" = "--hf-path" ] && s="$a"; [ "$prev" = "--mlx-path" ] && o="$a"; prev="$a"; done\n[ -d "$s" ] || exit 3\nmkdir -p "$o" && printf '{"block_size":16}' > "$o/config.json"`,
  "mlx_vlm.server": "exit 0",
  uv: `echo "$@" >> "$UV_LOG"`,
};

function sandbox(tools = Object.keys(FAKES)) {
  const root = mkdtempSync(join(tmpdir(), "pi-mlx-cli-"));
  const dirs = { bin: join(root, "bin"), home: join(root, "home"), agent: join(root, "agent"), tmp: join(root, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d);
  for (const t of tools) writeFileSync(join(dirs.bin, t), `#!/bin/sh\n${FAKES[t]}\n`), chmodSync(join(dirs.bin, t), 0o755);
  const env = { HOME: dirs.home, PATH: `${dirs.bin}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: dirs.agent, TMPDIR: dirs.tmp, UV_LOG: join(root, "uv.log") };
  const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { ...dirs, root, cli };
}

test("pi-mlx without a terminal lists the catalog by easy name with drafters and size", () => {
  const { cli } = sandbox();
  const out = cli().stdout;
  assert.match(out, /^qwen3\.8-27b +DFlash2 \+ MTP +16 GB$/m);
  assert.match(out, /^lfm2\.5-2\.6b +DSpark +5 GB$/m);
  assert.match(out, /^lfm3-1\.7b +no drafter/m);
  assert.match(out, /pi-mlx pull <name>/);
});

test("pi-mlx pull shows each step with the tools' own progress, saves into the models folder, and Pi's list picks it up", () => {
  const s = sandbox();
  const res = s.cli("pull", "qwen3.5-9b");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[1\/4\] mlx-community\/Qwen3\.5-9B-4bit, 6 GB/);
  assert.match(res.stdout, /\[3\/4\] DFlash drafter to 4-bit/);
  assert.match(res.stdout, /fake-progress mlx-community\/Qwen3\.5-9B-4bit 100%/);
  assert.match(res.stdout, /Done\. In Pi, pick it with \/model: mlx\/qwen3\.5-9b@dflash, mlx\/qwen3\.5-9b@mtp, mlx\/qwen3\.5-9b /);
  const models = join(s.agent, "mlx-vlm", "models");
  const saved = JSON.parse(readFileSync(join(s.agent, "mlx-vlm.json"), "utf8")).models;
  assert.deepEqual(saved.map((m: any) => [m.id, m.path]), [
    ["qwen3.5-9b", join(models, "mlx-community/Qwen3.5-9B-4bit")],
    ["qwen3.5-9b@dflash", join(models, "mlx-community/Qwen3.5-9B-4bit")],
    ["qwen3.5-9b@mtp", join(models, "mlx-community/Qwen3.5-9B-4bit")],
  ]);
  assert.equal(JSON.parse(readFileSync(join(models, "z-lab/Qwen3.5-9B-DFlash-4bit", "config.json"), "utf8")).block_size, 4);
  assert.ok(!existsSync(join(s.tmp, "pi-mlx", "Qwen3.5-9B-DFlash")), "the bf16 drafter download is removed after conversion");
  assert.match(s.cli().stdout.split("\n")[0], /^qwen3\.5-9b +DFlash \+ MTP +✓ pulled$/);
  assert.match(s.cli("list").stdout, /mlx\/qwen3\.5-9b@dflash +.*models\/mlx-community\/Qwen3\.5-9B-4bit/);
});

test("pi-mlx rm deletes the model and drafter folders no other model uses, and drops its /model entries", () => {
  const s = sandbox();
  s.cli("pull", "qwen3.5-9b");
  s.cli("pull", "lfm2.5-2.6b");
  const models = join(s.agent, "mlx-vlm", "models");
  const res = s.cli("rm", "qwen3.5-9b");
  assert.equal(res.status, 0, res.stderr);
  for (const d of ["mlx-community/Qwen3.5-9B-4bit", "mlx-community/Qwen3.5-9B-MTP-4bit", "z-lab/Qwen3.5-9B-DFlash-4bit"]) assert.ok(!existsSync(join(models, d)), d);
  assert.ok(existsSync(join(models, "LiquidAI/LFM2.5-2.6B")));
  assert.deepEqual(JSON.parse(readFileSync(join(s.agent, "mlx-vlm.json"), "utf8")).models.map((m: any) => m.id), ["lfm2.5-2.6b", "lfm2.5-2.6b@dspark"]);
  assert.equal(s.cli("rm", "qwen3.5-9b").status, 1);
});

test("pi-mlx never installs mlx-vlm without asking; without a terminal it prints the uv command", () => {
  const s = sandbox(["uv"]);
  const res = s.cli("pull", "qwen3.5-9b");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /uv tool install mlx-vlm && uv tool install huggingface_hub/);
  assert.ok(!existsSync(join(s.root, "uv.log")));
  assert.ok(!existsSync(join(s.agent, "mlx-vlm.json")));
});

test("installing the package links pi-mlx into ~/.local/bin and never replaces an existing one", () => {
  const s = sandbox();
  const install = () => spawnSync("npm", ["run", "postinstall", "--silent"], { cwd: join(CLI, "..", ".."), env: { ...process.env, HOME: s.home }, encoding: "utf8" });
  assert.equal(install().status, 0);
  const link = join(s.home, ".local", "bin", "pi-mlx");
  assert.equal(readlinkSync(link), CLI);
  assert.match(spawnSync(link, ["list"], { env: { ...process.env, PI_CODING_AGENT_DIR: s.agent }, encoding: "utf8" }).stdout, /No models pulled yet/);
  rmSync(link), writeFileSync(link, "mine");
  assert.equal(install().status, 0);
  assert.equal(readFileSync(link, "utf8"), "mine");
});

test("pi-mlx pull with no model prints usage and fails", () => {
  const res = sandbox().cli("pull");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage/);
});
