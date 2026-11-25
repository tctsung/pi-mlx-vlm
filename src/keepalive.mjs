// Keep-alive watchdog started next to the mlx-vlm server (args: base URL, server pid, idle seconds): unloads the model once nothing is in flight and the last request is older than the keep-alive, exits when the server process is gone.
const [base, pid, secs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const start = Date.now() / 1000;
const alive = () => { try { return process.kill(pid, 0); } catch { return false; } };
while (alive()) {
  await new Promise((r) => setTimeout(r, Math.min(15, Math.max(1, secs / 2)) * 1000));
  const m = await fetch(`${base}/metrics`).then((r) => r.json(), () => null);
  if (!m?.server?.loaded_model || (m.summary?.in_flight ?? 0) > 0) continue;
  if (Date.now() / 1000 - Math.max(m.summary?.last_request_at ?? 0, start) >= secs) await fetch(`${base}/unload`, { method: "POST" }).catch(() => {});
}
