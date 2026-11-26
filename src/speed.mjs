// mlx-vlm decode-speed readout for the Pi footer.
//
// mlx-vlm reports a per-chunk decode rate in every streamed chunk's `timings`
// field. Pi's openai-completions adapter parses only the token counts, so the
// speed is dropped; this recovers it and writes it to the footer.
//
// Only the last chunk is shown: it carries the response's authoritative average.
// A live chunk's rate is unreliable under speculative decoding (one chunk can hold
// several drafted tokens, so the value spikes to absurd numbers), and the footer
// persists the value after a turn, so there is no need to repaint it live.
// Off with PI_MLX_SPEED=0.

export const SPEED_ENV = "PI_MLX_SPEED";
const KEY = "mlx-tok-s";

function enabled(env) {
  const v = env?.[SPEED_ENV];
  if (v === undefined) return true;
  return v !== "0" && v.toLowerCase() !== "false" && v.toLowerCase() !== "off";
}

// The rate a chunk reports: the last chunk carries the full GenerationTimings
// (authoritative), a live chunk carries a StreamingTimings; older servers may use
// `server_timings`. Guarded so a malformed chunk never throws.
export function speedFromChunk(data) {
  const t = data?.timings;
  if (t && typeof t.predicted_per_second === "number" && t.predicted_per_second > 0) return t.predicted_per_second;
  const s = data?.server_timings?.decode_per_second;
  return typeof s === "number" && s > 0 ? s : undefined;
}

// The last chunk of a response carries `usage` with no `choices`; a content or
// finish chunk still has a `choices` entry and its per-chunk rate is the spiky
// speculative-decode live value.
export function isFinalChunk(data) {
  return Boolean(data?.usage) && !data.choices?.length;
}

export function formatSpeed(tokPerSec) {
  return tokPerSec && Number.isFinite(tokPerSec) && tokPerSec > 0 ? `${tokPerSec.toFixed(1)} tok/s` : undefined;
}

// Wire the readout onto a Pi extension api. No-op unless enabled; the mlx check
// is per-handler so a mid-session model switch is respected. Safe headless.
export function registerSpeed(api, deps) {
  const on = api?.on;
  if (typeof on !== "function" || !enabled(deps?.env)) return;
  on("provider_stream_event", (ev, ctx) => {
    if (ctx?.model?.provider !== "mlx" || !isFinalChunk(ev?.data)) return;
    const text = formatSpeed(speedFromChunk(ev.data));
    if (text) {
      try { ctx.hasUI === false || ctx.ui.setStatus(KEY, text); } catch {}
    }
  });
}
