# pi-mlx-vlm

Run local MLX models in the [Pi](https://github.com/earendil-works/pi) coding agent with [mlx-vlm](https://github.com/Neywa-Labs/mlx-vlm), sped up by speculative decoding (MTP, DFlash, DFlash2, DSpark). Ollama-style: pull a model, pick it in `/model`, chat. Everything stays on `127.0.0.1`.

## Install

Requires an Apple Silicon Mac and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```sh
pi install git:github.com/tctsung/pi-mlx-vlm
```

## Get a model

```sh
pi-mlx pull                                           # pick from the built-in list
pi-mlx pull qwen3.5-9b                                # with every known drafter
pi-mlx pull qwen3.8-27b dflash2                       # with one drafter
pi-mlx pull mlx-community/Qwen3.5-9B-8bit             # other bits: pick the repo, same drafters
pi-mlx pull <mlx-repo> dflash --draft <drafter-repo>  # any model mlx-vlm supports
pi-mlx list
pi-mlx rm qwen3.5-9b
```

The first pull asks to install mlx-vlm with uv. Models: [mlx-community](https://huggingface.co/mlx-community/models). Drafters, for example: [z-lab DFlash2](https://huggingface.co/collections/z-lab/dflash-2).

## Use

| In Pi | What it does |
|---|---|
| `/model` | Pick `mlx/<name>` (no drafter) or `mlx/<name>@<drafter>`. Switching needs no restart. |
| `/thinking` | Set the reasoning level, among those the model supports. |
| `/mlx status` | Server, loaded model, drafter. |
| `/mlx unload` | Free the model's memory now. |

## Decode speed

Ollama-style: the mlx-vlm decode speed (tok/s) shows in Pi's footer after each turn, and the same number is the chart's bars.

![Decode speed: Ollama vs mlx-vlm with drafters](bench/speed.svg)

Same 4-bit Qwen3.8 27B on two machines — M5 Ultra is ~5× the M3 Pro. A drafter recovers most of the gap between mlx-vlm and Ollama on every chip.

## Config

Environment variables, read when the server starts (restart it with `pkill -f mlx_vlm.server`).

| Variable | Default | Effect |
|---|---|---|
| `PI_MLX_KEEP_ALIVE` | `5m` | Unload after this much idle time; `-1` never. |
| `MLX_VLM_MAX_NUM_SEQS` | `1` | Requests decoded at once; more queue. |
| `PI_MLX_MODELS` | `~/.pi/agent/mlx-vlm/models` | Where models are saved. |
| `PI_MLX_PORT` | `8080` | Server port; a free one is picked if it's taken. |

Other `MLX_VLM_*` and `APC_*` variables go to mlx-vlm as is. The server log is `~/.pi/agent/mlx-vlm/server.log`.

Design notes and benchmarks: [docs/NOTES.md](docs/NOTES.md).
