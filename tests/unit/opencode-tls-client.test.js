import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// The free gate keys on the TLS ClientHello: on one process and egress IP the
// same body/headers answered 429 over Node's OpenSSL fingerprint and 200 over
// the cipher list below. These tests pin the wiring, not the upstream.
const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  it("includes lazy runtime dependencies in the Docker runner image", () => {
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    const builderInstall = dockerfile.indexOf("npm install --no-save");
    const runnerStage = dockerfile.indexOf("FROM ${NODE_IMAGE} AS runner");
    const runtimeCopy = dockerfile.indexOf("COPY --from=builder /opt/lazy-runtime/node_modules/. ./node_modules/");

    expect(builderInstall).toBeGreaterThan(-1);
    expect(runnerStage).toBeGreaterThan(builderInstall);
    expect(runtimeCopy).toBeGreaterThan(runnerStage);
    expect(dockerfile.slice(builderInstall, runnerStage)).toContain("wreq-js playwright-core");
  });

  it("uses the cipher list the upstream accepts and sends ALPN-negotiated requests", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const options = createSessionMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    // BoringSSL family list: AES-128-GCM first plus the legacy CBC entries the
    // upstream fingerprints on. Dropping any of them is refused upstream.
    expect(__test__.OPENCODE_CIPHER_LIST.split(":")).toHaveLength(17);
    expect(__test__.OPENCODE_CIPHER_LIST.startsWith("TLS_AES_128_GCM_SHA256")).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
  });

  it("sends the Bun-true TLS profile, not just the cipher list", async () => {
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")), close: vi.fn() });
    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}" });

    const options = createSessionMock.mock.calls[0][0];
    // Byte-for-byte Bun 1.3.14 ground truth (tls.peet.ws capture 2026-10-27):
    // ALPN http/1.1 only, X25519/P-256/P-384 groups, OCSP + SCT extensions on,
    // and the existing verbatim cipher list. sigalgs need no override.
    expect(options.emulation.tlsOptions).toEqual({
      cipherList: __test__.OPENCODE_CIPHER_LIST,
      alpnProtocols: ["HTTP1"],
      curvesList: "X25519:P-256:P-384",
      enableOcspStapling: true,
      enableSignedCertTimestamps: true,
    });
  });

  it("reuses one session across requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps one session per proxy and reuses it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });
    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://p1:8080" });
    await opencodeTlsFetch("https://opencode.ai/b", {}, { proxyUrl: "http://p1:8080" });
    await opencodeTlsFetch("https://opencode.ai/c", {}, {});
    await opencodeTlsFetch("https://opencode.ai/d", {}, { proxyUrl: "http://p2:8080" });

    // direct + p1 + p2 = 3 sessions; p1 reused
    expect(createSessionMock).toHaveBeenCalledTimes(3);
    const proxied = createSessionMock.mock.calls.map(([o]) => o.proxy).filter(Boolean);
    expect(proxied.sort()).toEqual(["http://p1:8080", "http://p2:8080"]);
    const direct = createSessionMock.mock.calls.find(([o]) => o.proxy === undefined && !("proxy" in o));
    expect(direct).toBeTruthy();
  });

  it("drops a failed proxied session so the next call recreates it", async () => {
    createSessionMock.mockImplementationOnce(() => Promise.reject(new Error("proxy dead")));
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")), close: vi.fn() });
    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import("../../open-sse/services/opencodeTlsClient.js");

    const error = await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://p1:8080" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(OpencodeTlsUnavailableError);
    // A proxied failure names the proxy URL so operators can tell which egress
    // pool died; the direct path appends nothing.
    expect(error.message).toContain(" via http://p1:8080");
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://p1:8080" });
    expect(createSessionMock).toHaveBeenCalledTimes(2);
  });

  it("closes the least-recently-used session above the cache cap", async () => {
    const closes = [];
    createSessionMock.mockImplementation(async () => ({
      fetch: vi.fn().mockResolvedValue(new Response("ok")),
      close: () => { closes.push(closes.length + 1); },
    }));
    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    for (let i = 0; i <= __test__.MAX_TLS_SESSIONS; i++) {
      await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: `http://p${i}:8080` });
    }
    expect(createSessionMock).toHaveBeenCalledTimes(__test__.MAX_TLS_SESSIONS + 1);
    expect(closes).toHaveLength(1); // oldest (p0) evicted and closed
  });

  it("surfaces an actionable error when wreq-js is unavailable", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));

    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );

    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toBeInstanceOf(
      OpencodeTlsUnavailableError
    );
  });

  it("forwards the abort signal so a cancelled stream stops upstream", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/a", {}, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
