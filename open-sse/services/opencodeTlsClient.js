// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not on headers: a request that
// passes from the OpenCode CLI is refused with 429 FreeUsageLimitError when the
// same body/headers ride Node's OpenSSL fingerprint, and passes again once the
// cipher list matches. Measured 2026-10-26 on one process, one egress IP, three
// transports: node fetch/https/http2 all 429, Bun's BoringSSL fetch 200.
// JA4's cipher hash identifies the list (Bun: 5b57614c22b0), so the match is on
// the cipher-list hash and nothing else — reordering the same list still
// passes. Gate-passing on the cipher list is necessary but not sufficient to BE
// Bun: OPENCODE_TLS_PROFILE below additionally sends the ALPN/groups/OCSP/SCT
// shape, so the full ja3/ja4 fingerprint — not just the gate hash — is
// byte-identical to a real Bun 1.3.14 client.
//
// wreq-js is an optional dependency; when absent the caller keeps its native
// fetch and stays subject to the gate rather than failing the request here.

import { loadRuntimeDep } from "./lazyRuntime.js";

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

// Full Bun TLS profile (wreq CustomTlsOptions). Beyond the cipher list, Bun's
// ClientHello differs from wreq's defaults in exactly these places, measured
// against Bun 1.3.14 via tls.peet.ws on 2026-10-27:
// - ALPN offers http/1.1 only (bun fetch is an HTTP/1.1 client on this line;
//   flip to ["HTTP2","HTTP1"] only if the upstream starts wanting the h2 variant)
// - supported groups X25519, P-256, P-384 in that order
// - status_request (OCSP) and signed_certificate_timestamp (SCT) extensions,
//   which wreq leaves off by default — without them ja3/ja4 diverge from Bun
// wreq's remaining defaults (min 1.2/1.3 both, session_ticket, sigalgs order,
// key share X25519, ClientHello padding) already match Bun byte-for-byte.
const OPENCODE_TLS_PROFILE = {
  cipherList: OPENCODE_CIPHER_LIST,
  alpnProtocols: ["HTTP1"],
  curvesList: "X25519:P-256:P-384",
  enableOcspStapling: true,
  enableSignedCertTimestamps: true,
};

const DEFAULT_TIMEOUT_MS = 120000;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

const DIRECT_SESSION_KEY = "direct";
const MAX_TLS_SESSIONS = 32;
const tlsSessions = new Map();

function sessionKey(proxyUrl) {
  return String(proxyUrl || DIRECT_SESSION_KEY);
}

async function loadSession(proxyUrl) {
  const key = sessionKey(proxyUrl);
  const cached = tlsSessions.get(key);
  if (cached) {
    // LRU touch
    tlsSessions.delete(key);
    tlsSessions.set(key, cached);
    return cached.promise;
  }

  const promise = (async () => {
    const wreq = await loadRuntimeDep("wreq-js");
    if (typeof wreq.createSession !== "function") {
      throw new Error("wreq-js runtime is missing createSession");
    }
    // wreq's proxy is session-scoped, so one session per proxy URL keeps the
    // connection pool and TLS session tickets per egress instead of thrashing
    // them across pool members (#5275). alpnProtocols is deep-copied so a
    // mutating wreq build cannot poison the module-level profile const.
    return wreq.createSession({
      emulation: {
        tlsOptions: {
          ...OPENCODE_TLS_PROFILE,
          alpnProtocols: [...OPENCODE_TLS_PROFILE.alpnProtocols],
        },
      },
      ...(key === DIRECT_SESSION_KEY ? {} : { proxy: key }),
    });
  })().catch((error) => {
    tlsSessions.delete(key);
    throw error;
  });
  tlsSessions.set(key, { promise });

  while (tlsSessions.size > MAX_TLS_SESSIONS) {
    const oldest = tlsSessions.keys().next().value;
    const evicted = tlsSessions.get(oldest);
    tlsSessions.delete(oldest);
    evicted.promise.then((session) => session.close?.()).catch(() => {});
  }
  return promise;
}

/** Drop every cached session so the next call builds fresh ones. */
export function resetOpencodeTlsSession() {
  const entries = [...tlsSessions.values()];
  tlsSessions.clear();
  for (const entry of entries) {
    entry.promise.then((session) => session.close?.()).catch(() => {});
  }
}

/**
 * Fetch through the impersonated-TLS session, optionally through `proxyUrl`.
 * Returns a native Response so downstream `.body` / `.text()` / `.json()`
 * consumers keep working unchanged. Streaming is preserved: the response body
 * is handed over as the live ReadableStream, never buffered.
 */
export async function opencodeTlsFetch(url, init = {}, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, proxyUrl } = {}) {
  let session;
  try {
    session = await loadSession(proxyUrl);
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (signal) options.signal = signal;

  const res = await session.fetch(url, options);
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export const __test__ = { OPENCODE_CIPHER_LIST, OPENCODE_TLS_PROFILE, MAX_TLS_SESSIONS };
