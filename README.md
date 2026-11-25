# pi-mlx-vlm

A native local LLM backend for the [Pi](https://github.com/earendil-works/pi) coding agent, built on [mlx-vlm](https://github.com/Neywa-Labs/mlx-vlm). It speeds up inference on Apple Silicon with speculative decoding (MTP, DFlash, DFlash2) and keeps the Ollama-style experience: pull a model, pick it in `/model`, chat. Everything runs locally on `127.0.0.1`, next to Ollama.

## Speed

Charts for MacBook Pro (M1 Pro) and Mac Studio (Ultra) are coming. Raw results so far (M3 Pro): [bench/results.json](bench/results.json) (Qwen3.5 9B) and [bench/results-27b.json](bench/results-27b.json) (Qwen3.8 27B).

## Install

```sh
pi install git:github.com/tctsung/pi-mlx-vlm
```

Then, inside Pi, pick a model from the list. The first time, it asks to install mlx-vlm with `uv`:

```text
/mlx model
```

Or pull a specific model and drafter:

```text
/mlx pull mlx-community/Qwen3.5-9B-4bit mtp
/mlx pull mlx-community/Qwen3.8-27B-4bit dflash
/mlx pull <mlx-repo> dflash --draft <drafter-repo>
```

## Use

| In Pi | What it does |
|---|---|
| `/model` | Each pulled model has up to three entries: `mlx/<repo>` (no drafter), `mlx/<repo>@mtp`, `mlx/<repo>@dflash`. Switching between them, or to `ollama/*`, needs no restart. |
| `/thinking` | Qwen3.8: `off`, `low`, `medium`, `high`. Qwen3.5: `off` or `medium` (on). The first request after a change re-reads the prompt, as on Ollama. |
| `/mlx model` | Lists models with verified drafters and marks what is installed. Enter pulls one (or switches to it if already installed). |
| `/mlx pull <repo> [mtp\|dflash] [--draft <repo>]` | Pulls any mlx-vlm model with its drafter, like `ollama pull`. `dflash` uses DFlash2 where the drafter is DFlash2. The DFlash drafter is converted to 4-bit. |
| `/mlx status` | Server state, loaded model, active drafter, pulled entries. |
| `/mlx unload` | Frees the model's memory now. The next request loads it again. |

The server starts on the first `mlx/*` request and is shared by all Pi sessions. Switching entries changes the drafter at runtime; nothing restarts. Update the model list with `pi update`, and mlx-vlm itself with `uv tool upgrade mlx-vlm`.

## Config

Environment variables, read when the server starts. Set them in your shell profile. To apply a change, stop the server with `pkill -f mlx_vlm.server`; the next request starts it again.

| Variable | Default | Effect |
|---|---|---|
| `PI_MLX_KEEP_ALIVE` | `5m` | Unload the model after this much idle time, like `OLLAMA_KEEP_ALIVE`. Accepts `30s`, `10m`, `1h`, seconds, or `-1` for never. |
| `MLX_VLM_MAX_NUM_SEQS` | `1` | Requests decoded at once, like `OLLAMA_NUM_PARALLEL`. Further requests queue. |
| `PI_MLX_PORT` | `8080` | Server port. The server always binds `127.0.0.1`, so it is not reachable from other machines. Ollama keeps 11434. |

Any other mlx-vlm variable you set (`MLX_VLM_*`, `APC_*`) is passed through and overrides the extension's defaults.

## Files

| Path | Contents |
|---|---|
| `~/.pi/agent/mlx-vlm.json` | Pulled models and drafters (the source of the `/model` list) |
| `~/.pi/agent/mlx-vlm/drafters/` | 4-bit converted DFlash drafters |
| `~/.pi/agent/mlx-vlm/server.log` | Server log, with per-request tok/s |
| `~/.cache/huggingface/` | Model weights, shared with other Hugging Face tools |

Design notes, measurements, known gaps and development commands: [NOTES.md](NOTES.md).
