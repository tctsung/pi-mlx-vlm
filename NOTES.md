# Notes

Design notes and Phase 0 findings. Code has no inline comments; anything worth explaining lives here.

## Phase 0: what was verified by hand

Machine: Apple M3 Pro, 36 GB. mlx-vlm 0.8.1 (PyPI, same as `main` on 2026-11-24), Pi 1.6.0, Ollama 0.40.18.
Test model `mlx-community/Qwen3.5-9B-4bit` with `mlx-community/Qwen3.5-9B-MTP-4bit` (164 MB) and `z-lab/Qwen3.5-9B-DFlash` (2.6 GB bf16, 694 MB at 4-bit).

| Check | Result |
|---|---|
| Server bind | `--host 127.0.0.1` gives `TCP 127.0.0.1:8080 (LISTEN)` in `lsof`. The default would be `0.0.0.0`. |
| Pi chat through `openai-completions` | Text, streamed `delta.reasoning` (shown as thinking), and streamed tool calls all work. |
| `PATCH /v1/settings {draft_model, draft_kind}` | Applied live; `reload_kinds: ["text_generation"]`; the next request reloads the target with the new drafter in a few seconds. One server is enough, so there's no per-pairing process. |
| `draft_model: null` | Only turns drafting off if the server was **started without** `--draft-model`. The CLI flag is copied into `MLX_VLM_DRAFT_MODEL`, and `null` falls back to it. So the extension starts the server bare and sets every drafter through PATCH. |
| Sampling defaults | mlx-vlm defaults to greedy (`temperature 0`). The extension sends each family's Ollama Modelfile values through Pi `samplingParams`, so both engines sample the same way: Qwen3.5 `temperature 1, top_k 20, top_p 0.95, presence_penalty 1.5` (thinking off: `0.7 / 0.8`); Qwen3.8 `temperature 1, top_k 20, top_p 0.95` with no presence penalty. |
| Thinking control | `reasoning_effort` maps to `enable_thinking` plus a template kwarg. `none` turns thinking off. The Qwen3.8 template accepts `low / medium / xhigh` (default `xhigh`); the Qwen3.5 template only supports on/off. |

## Findings that changed the design

1. **Prefix cache matters more than the drafter for agent work.** A 4-turn Pi task sends ~5.3K prompt tokens per turn. With mlx-vlm's APC off (its default), every turn re-prefills: 78 s for the task. With `APC_ENABLED=1` it takes 31 s, and 15.8K of 21.4K prompt tokens are read from cache. The extension always starts the server with APC on, memory tier only (`APC_DISK_ENABLED=0`, so no silent 20 GB disk cache).
2. **DFlash block size is hardware-sensitive.** Qwen3.5-9B DFlash ships `block_size: 16`. Server tok/s on the M3 Pro, same three prompts, sampled:

   | block | 16 | 8 | 6 | 5 | 4 | 3 | MTP | no drafter |
   |---|---|---|---|---|---|---|---|---|
   | tok/s | 34-41 | 42-46 | 44-49 | 44-49 | **47-55** | 41-44 | 40-43 | 25 |

   The upstream DFlash2 PR (#2014) found the same on an M5 Max (3 rows beat 4 and 5), and DFlash2 defaults to 3 rows. The catalog writes `block_size: 4` into the converted Qwen3.5-9B drafter. Qwen3.8 DFlash2 keeps upstream's default.
3. **bf16 vs 4-bit DFlash drafter**: same speed here (28.9 vs 29.2 tok/s at block 16), and 4-bit saves ~1.9 GB, so `pull` always converts.
4. **Ollama's own MTP tag** (`qwen3.5:9b-mtp-q4`) fails to pull on Ollama 0.40.18 (`file does not exist`), so the Ollama baseline is the MLX tag `qwen3.5:9b-mlx` (nvfp4). That matches the "-mlx" tags in the current setup.
5. **With thinking on, task time follows thinking length, not decode speed.** Decode stays ~2.3× faster with DFlash, but on the 9B the mlx runs wrote 870-921 output tokens per task versus Ollama's 663, so the task-time bars are close. Thinking off is the fair comparison for raw speed.
6. **Switching entries reloads the model.** A drafter change makes the server reload the target on the next request and drops the prefix cache. On the 9B the first request after a switch takes ~15 s; later requests are warm.
7. **Ollama's 27B MLX tag has MTP built in.** `qwen3.8:27b-mlx` contains `mtp.*` tensors and Ollama 0.40.18 speculates with them: 23.5 tok/s (22.5 by Ollama's own `eval_duration`), against 18.0 for mlx-vlm + MTP (drafter `block_size: 3`, adaptive) and 18.7 for DFlash2 (adaptive, starts at 3 rows, ceiling 5) on the M3 Pro. Plain mlx-vlm gets 8.7, which is about the memory-bandwidth limit for an 18 GB dense model. DFlash2's block sizing is already adaptive upstream, so no sweep was done.

## Design choices

- **One provider, one server, many entries.** `/model` entries are `mlx/<repo>`, `mlx/<repo>@mtp` and `mlx/<repo>@dflash`. Before each request, `before_provider_request` (awaited by Pi) starts the server if it's down, PATCHes the drafter only when it differs, and rewrites `payload.model` to the bare repo.
- **Plain entry kept.** `mlx/<repo>` (no drafter) costs nothing extra and makes a three-way A/B possible.
- **Catalog file** `~/.pi/agent/mlx-vlm.json` holds pulled pairings. The model list comes from it, not from `/v1/models`, which also lists drafters.
- **Converted drafters** go to `~/.pi/agent/mlx-vlm/drafters/`, and the server log to `~/.pi/agent/mlx-vlm/server.log`.
- **The server is detached.** It outlives Pi (like Ollama), so the model stays warm between sessions. `/mlx unload` frees the memory. To stop it: `pkill -f mlx_vlm.server`.
- **Binaries** are looked up in `~/.local/bin` (uv's tool dir) and then `PATH`, so a fresh shell works right after `uv tool install`.
- **Port** is 8080, overridable with `PI_MLX_PORT`. Ollama stays on 11434.
- **Non-interactive setup.** In `pi -p` there is no UI, so `/mlx setup` picks the first MLX match for an installed Ollama model and prints to stdout. It won't install anything without a UI to ask in; it prints the exact `uv tool install` command instead.

## Safety

- The server binds `127.0.0.1` only (asserted in unit tests and in `test/e2e.ts` with `lsof`). No API key is used on loopback, and no port is published.
- `uv tool install` runs only after `ctx.ui.confirm`.
- Nothing is deleted. Ollama and its models are untouched.

## Known gaps

- `/mlx pull` shows a status line, not download progress (it uses `pi.exec`, which buffers output).
- Running an Ollama model and an mlx model back to back keeps both in memory until Ollama's 5-minute keep-alive expires.
- `--draft <repo>` with both methods uses the same repo for both; pass one method with `--draft`.
- The drafter is a server-wide setting. Two Pi sessions using different `mlx/*` entries at the same time make the server reload on every switch. Use one entry per machine at a time, or the fallback from the plan: one server per pairing on separate ports.
- Changing `/thinking` on Qwen3.8 invalidates the prefix cache. The model's chat template writes the reasoning-effort sentence at the start of the system prompt, so the first request at a new level re-prefills Pi's ~5K-token system prompt. On the 27B on the M3 Pro that took ~50 s (`cached_tokens=0`, 102 tok/s prefill), against 12 s at the cached level. Measured through `pi -p` on `@dflash`: off 12 s, low 55 s, medium 54 s, high 55 s, with 16-58 generated tokens each. Later requests at the same level are cached. Ollama renders the same template.
- The DFlash block size is tuned for the M3 Pro. On bigger chips, re-check with `bench/bench.ts`, or by editing `block_size` in the converted drafter's `config.json`.
