/**
 * Wait for the Docker backend + worker health endpoints to report healthy
 * before starting E2E tests. Cross-platform (Node.js) so it works on Windows
 * and Unix without shell-specific syntax.
 */

const BACKEND_HEALTH = process.env.BACKEND_HEALTH_URL || 'http://localhost:34567/api/health';
const WORKER_HEALTH = process.env.WORKER_HEALTH_URL || 'http://localhost:3001/health';

// L6a: validate parseInt results — WAIT_TIMEOUT_MS=abc previously produced
// NaN (immediate timeout or busy poll).
function parsePositiveInt(raw, fallback, name) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name} must be a positive integer, got '${raw}' — using default ${fallback}`);
    return fallback;
  }
  return n;
}
const TIMEOUT_MS = parsePositiveInt(process.env.WAIT_TIMEOUT_MS, 120000, 'WAIT_TIMEOUT_MS');
const INTERVAL_MS = parsePositiveInt(process.env.WAIT_INTERVAL_MS, 2000, 'WAIT_INTERVAL_MS');

async function checkUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    // L6a: `|| res.status === 200` made the JSON checks dead code — ANY 200
    // (including {"status":"degraded"} or an unrelated server on the port)
    // counted as healthy. Require the healthy contract of each service:
    // backend /api/health → {success:true, data:{status:'healthy'}},
    // worker /health → {status:'ok'|'ready'}.
    return (
      (body.success === true && body.data?.status === 'healthy') ||
      body.status === 'ok' ||
      body.status === 'ready'
    );
  } catch {
    return false;
  }
}

async function waitForService(name, url) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (await checkUrl(url)) {
      console.log(`[wait-for-stack] ${name} is healthy: ${url}`);
      return;
    }
    const elapsed = Date.now() - start;
    console.log(`[wait-for-stack] ${name} not ready yet (${elapsed}ms)...`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  throw new Error(`[wait-for-stack] Timed out waiting for ${name} at ${url} after ${TIMEOUT_MS}ms`);
}

async function main() {
  await Promise.all([
    waitForService('backend', BACKEND_HEALTH),
    waitForService('worker', WORKER_HEALTH),
  ]);
  console.log('[wait-for-stack] All services healthy — proceeding to tests.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
