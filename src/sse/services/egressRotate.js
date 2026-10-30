// Ask the local egress proxy to rotate its exit IP after upstream exhaustion.
//
// The proxy (sock2http in -codespace mode) terminates no TLS for LLM traffic, so
// it cannot see a provider 429 itself: CONNECT tunnels are opaque to it. This
// gateway is the only party holding the plaintext response, so it has to push
// the signal. Interface is one localhost POST; the transport behind it (GitHub
// Codespaces, WARP, paid proxies) stays entirely the proxy's business.
//
// Opt-in via SOCK2HTTP_ROTATE_URL. Unset = no-op, so nothing fires by default.
// Fail-open: rotation is an optimization, never a reason to fail a request.

// Config precedence: settings row (PATCH /api/settings, no restart) then env.
// Settings is the primary path because this gateway is normally configured
// through the dashboard, not a .env file.
const DEFAULT_MIN_INTERVAL_MS = 60_000;
const ROTATE_TIMEOUT_MS = 10_000;
const ROTATABLE_STATUSES = new Set([429, 503]);
const SETTINGS_TTL_MS = 5_000;

let lastAttempt = 0;
let inFlight = false;
let cachedConfig = null;
let cachedAt = 0;

async function rotationConfig() {
  if (cachedConfig && Date.now() - cachedAt < SETTINGS_TTL_MS) return cachedConfig;

  let url = (process.env.SOCK2HTTP_ROTATE_URL || "").trim();
  let token = (process.env.SOCK2HTTP_ROTATE_TOKEN || "").trim();
  let minIntervalMs = Number(process.env.SOCK2HTTP_ROTATE_MIN_INTERVAL_MS);

  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    url = (settings.egressRotateUrl || url || "").trim();
    token = (settings.egressRotateToken || token || "").trim();
    minIntervalMs = Number(settings.egressRotateMinIntervalMs) || minIntervalMs;
  } catch {
    // Settings unavailable (early boot, tests): fall through to env.
  }

  cachedConfig = resolveConfig(url, token, minIntervalMs);
  cachedAt = Date.now();
  return cachedConfig;
}

function resolveConfig(rawUrl, token, minIntervalMs) {
  const raw = (rawUrl || "").trim();
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
    minIntervalMs: minIntervalMs > 0 ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS,
  };
}

/**
 * Request a new exit IP after an upstream rate-limit/exhaustion event.
 * Fire-and-forget; resolves to whether a rotation was actually dispatched.
 */
export async function requestEgressRotation(status) {
  if (!ROTATABLE_STATUSES.has(Number(status))) return false;

  const config = await rotationConfig();
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
