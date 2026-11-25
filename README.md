# pi-mlx-vlm

A native local LLM backend for the [Pi](https://github.com/earendil-works/pi) coding agent, built on [mlx-vlm](https://github.com/Neywa-Labs/mlx-vlm). It speeds up inference on Apple Silicon with speculative decoding (MTP, DFlash, DFlash2, DSpark) and keeps the Ollama-style experience: pull a model, pick it in `/model`, chat. Everything runs locally on `127.0.0.1`, next to Ollama.

## Speed

Charts for MacBook Pro (M1 Pro) and Mac Studio (Ultra) are coming. Raw results so far (M3 Pro): [bench/results.json](bench/results.json) (Qwen3.5 9B) and [bench/results-27b.json](bench/results-27b.json) (Qwen3.8 27B).

## Install

```sh
pi install git:github.com/tctsung/pi-mlx-vlm
```

Then, inside Pi, run `/mlx model`. The first time, it asks to install mlx-vlm with `uv`. Models you have are on top; Enter on one switches to it, Enter on any other pulls it with its drafters first:

```text
/mlx model
  qwen3.5-9b        DFlash + MTP     ✓ installed
  qwen3.8-27b       DFlash2 + MTP    16 GB
  qwen3.8-27b-8bit  DFlash2 + MTP    30 GB
  qwen3.5-4b        DFlash + MTP     3 GB
  gemma4-31b        DFlash + MTP     18 GB
  gemma4-26b-a4b    DFlash + MTP     15 GB
  gemma4-e4b        MTP              5 GB
  lfm2.5-2.6b       DSpark           5 GB
  lfm3-1.7b         no drafter       3.5 GB
  lfm3-vl-2b        no drafter       4 GB
```

The list is [catalog.json](catalog.json): easy names, verified drafter pairs, download size. Or pull by name or by any Hugging Face repo:

```text
/mlx pull qwen3.5-9b                              # with every drafter in the catalog
/mlx pull qwen3.8-27b dflash2                     # with one drafter
/mlx pull <mlx-repo> dflash --draft <drafter-repo> # any model mlx-vlm supports
```

Where to find models and drafters:

- Models: [mlx-community](https://huggingface.co/mlx-community) on Hugging Face has MLX weights for most open models (pick a `-4bit` repo). Check [mlx-vlm's supported models](https://github.com/Neywa-Labs/mlx-vlm/blob/main/docs/usage.md#supported-models).
- DFlash and DFlash2 drafters: [z-lab](https://huggingface.co/z-lab) (`<model>-DFlash`, `<model>-DFlash2`).
- MTP drafters: mlx-community `<model>-MTP-4bit` repos for Qwen, and `<model>-assistant-bf16` for [Gemma 4](https://github.com/Neywa-Labs/mlx-vlm#gemma-4-mtp).
- DSpark drafters: [LiquidAI](https://huggingface.co/LiquidAI) (`<model>-DSpark`).
- How each method works: [mlx-vlm speculative decoding](https://github.com/Neywa-Labs/mlx-vlm#speculative-decoding).

## Use

| In Pi | What it does |
|---|---|
| `/model` | Each pulled model has one entry per drafter, such as `mlx/qwen3.5-9b` (no drafter), `mlx/qwen3.5-9b@mtp`, `mlx/qwen3.5-9b@dflash`. Switching between them, or to `ollama/*`, needs no restart. |
| `/thinking` | Qwen3.8: `off`, `low`, `medium`, `high`. Qwen3.5, Gemma 4 and others: `off` or `medium` (on). The first request after a change re-reads the prompt, as on Ollama. |
| `/mlx model` | Installed models first, then the catalog. Enter switches to an installed model (fastest drafter first) or pulls a new one. |
| `/mlx pull <name\|repo> [mtp\|dflash\|dflash2\|dspark] [--draft <repo>]` | Pulls a catalog model with its drafters, or any mlx-vlm model by repo, like `ollama pull`. DFlash drafters are converted to 4-bit. |
| `/mlx status` | Server state, loaded model, active drafter, pulled entries. |
| `/mlx unload` | Frees the model's memory now. The next request loads it again. |

The server starts on the first `mlx/*` request and is shared by all Pi sessions. Switching entries changes the drafter at runtime; nothing restarts. Update the model list with `pi update`, and mlx-vlm itself with `uv tool upgrade mlx-vlm`.

## Config

Environment variables, read when the server starts. Set them in your shell profile. To apply a change, stop the server with `pkill -f mlx_vlm.server`; the next request starts it again.

| Variable | Default | Effect |
|---|---|---|
| `PI_MLX_KEEP_ALIVE` | `5m` | Unload the model after this much idle time, like `OLLAMA_KEEP_ALIVE`. Accepts `30s`, `10m`, `1h`, seconds, or `-1` for never. |
| `MLX_VLM_MAX_NUM_SEQS` | `1` | Requests decoded at once, like `OLLAMA_NUM_PARALLEL`. Further requests queue. |
| `PI_MLX_PORT` | `8080` | Server port. If another app holds it, Pi picks a free port at startup, says so, and remembers it. Set this only to pin a port; a conflict is then an error. The server always binds `127.0.0.1`, so other machines can't reach it. |

Any other mlx-vlm variable you set (`MLX_VLM_*`, `APC_*`) is passed through and overrides the extension's defaults.

## Files

| Path | Contents |
|---|---|
| `~/.pi/agent/mlx-vlm.json` | Pulled models and drafters (the source of the `/model` list) |
| `~/.pi/agent/mlx-vlm/drafters/` | 4-bit converted DFlash drafters |
| `~/.pi/agent/mlx-vlm/server.log` | Server log, with per-request tok/s |
| `~/.pi/agent/mlx-vlm/port` | Port picked when 8080 was taken |
| `~/.cache/huggingface/` | Model weights, shared with other Hugging Face tools |

Design notes, measurements, known gaps and development commands: [NOTES.md](NOTES.md).
