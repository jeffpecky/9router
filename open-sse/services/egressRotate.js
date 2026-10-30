// Ask the local egress proxy to rotate its exit IP after upstream exhaustion.
//
// The proxy (sock2http) terminates no TLS for LLM traffic, so it cannot see a
// provider 429 itself: CONNECT tunnels are opaque to it. This gateway is the
// only party holding the plaintext response, so it has to push the signal.
// Interface is one localhost POST; the transport behind it (GitHub Codespaces,
// WARP, paid proxies) stays entirely the proxy's business.
//
// Scoped to the OpenCode lane: the sock2http egress exists for the free-tier
// gate, whose binds (client fingerprint, session, IP) are exactly what a
// swap can clear. Other providers' 429s are account locks, not IP problems.
// The OpenCode executor is the only caller.
//
// Config comes from setEgressRotationConfig(), which the app layer calls once
// per request with dashboard-stored values (open-sse must not import @/lib
// itself — this module stays provider-agnostic), falling back to env vars.
// Unset = no-op. Fail-open: rotation is an optimization, never a reason to
// fail a request.

const DEFAULT_MIN_INTERVAL_MS = 60_000;
const ROTATE_TIMEOUT_MS = 10_000;
const ROTATABLE_STATUSES = new Set([429, 503]);

let lastAttempt = 0;
let inFlight = false;
let config = null;

/**
 * @param {{ egressRotateUrl?: string, egressRotateToken?: string,
 *           egressRotateMinIntervalMs?: number }} settings|null
 */
export function setEgressRotationConfig(settings) {
  config = resolveConfig(
    settings?.egressRotateUrl ?? process.env.SOCK2HTTP_ROTATE_URL,
    settings?.egressRotateToken ?? process.env.SOCK2HTTP_ROTATE_TOKEN,
    settings?.egressRotateMinIntervalMs ?? Number(process.env.SOCK2HTTP_ROTATE_MIN_INTERVAL_MS),
  );
}

function resolveConfig(rawUrl, token, minIntervalMs) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.warn("[EGRESS] egress rotate URL is not valid; egress rotation disabled");
    return null;
  }
  // Localhost only: the token rides in this request, and a remote URL would
  // both leak it and let a config change redirect quota-burning POSTs off-box.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (!isLoopback) {
    console.warn("[EGRESS] egress rotate URL must point at loopback; egress rotation disabled");
    return null;
  }
  if (!token) {
    console.warn("[EGRESS] egress rotate token is not set; the proxy will reject rotations with 403");
  }
  return {
    url: url.href,
    token,
    minIntervalMs:
      Number(minIntervalMs) > 0 ? Number(minIntervalMs) : DEFAULT_MIN_INTERVAL_MS,
  };
}

/**
 * Fire-and-forget proxy rotation for an upstream 429/503 on the OpenCode lane.
 * Resolves to whether a rotation was actually dispatched. The 60s default
 * interval accepts one rotation per request storm rather than one per retry.
 */
export async function requestEgressRotation(status) {
  if (!ROTATABLE_STATUSES.has(Number(status))) return false;
  if (!config) return false;

  const now = Date.now();
  // One rotation at a time, and never faster than the proxy can provision.
  // Without this a 429 storm would burn the whole codespace quota in seconds.
  if (inFlight || now - lastAttempt < config.minIntervalMs) return false;

  inFlight = true;
  lastAttempt = now;
  try {
    const headers = { "Content-Type": "application/json" };
    if (config.token) headers["X-Rotate-Token"] = config.token;

    const res = await fetch(config.url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(ROTATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 409 = proxy busy or cooling down; that is the normal, expected answer.
      const level = res.status === 409 ? "info" : "warn";
      console[level](`[EGRESS] rotation not performed (HTTP ${res.status}): ${body.slice(0, 200)}`);
      return false;
    }
    console.info("[EGRESS] rotation requested after upstream exhaustion");
    return true;
  } catch (err) {
    console.warn(`[EGRESS] rotation request failed: ${err?.message || err}`);
    return false;
  } finally {
    inFlight = false;
  }
}
