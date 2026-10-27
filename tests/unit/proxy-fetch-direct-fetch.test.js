import { describe, it, expect, vi, beforeEach } from "vitest";

const { undiciMocks, fetchStub } = vi.hoisted(() => {
  const dispatcherInstances = [];
  function Recorder(name) {
    // Regular function expression (not an arrow): vitest 4 only treats mocks
    // with a `function`/`class` implementation as constructible, and
    // getDispatcher() does `new ProxyAgent(...)` / `new Agent(...)`.
    return vi.fn(function recorder(opts = {}) {
      const instance = { name, opts, calls: [] };
      dispatcherInstances.push(instance);
      return instance;
    });
  }
  return {
    undiciMocks: { Agent: Recorder("Agent"), ProxyAgent: Recorder("ProxyAgent"), instances: dispatcherInstances },
    fetchStub: vi.fn(),
  };
});

vi.mock("undici", () => ({ Agent: undiciMocks.Agent, ProxyAgent: undiciMocks.ProxyAgent }));

// Reset state before each import of proxyFetch.js. The module captures the
// pristine global fetch at import time (const originalFetch = globalThis.fetch),
// so the stub must be installed BEFORE the dynamic import below.
beforeEach(() => {
  vi.resetModules();
  undiciMocks.instances.length = 0;
  undiciMocks.Agent.mockClear();
  undiciMocks.ProxyAgent.mockClear();
  fetchStub.mockReset();
  fetchStub.mockResolvedValue(new Response("native-ok", { status: 200 }));
  // Keep proxy resolution deterministic: a host-level env proxy would otherwise
  // shadow/nullify the connection-proxy assertions below (#5275).
  vi.stubEnv("HTTP_PROXY", "");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("ALL_PROXY", "");
  vi.stubEnv("all_proxy", "");
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  vi.stubGlobal("fetch", fetchStub);
});

describe("proxyAwareFetch directFetch contract (#5275)", () => {
  it("routes directFetch through a configured connection proxy, tunneling there", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const directResponse = new Response("tls-ok", { status: 200 });
    const directFetch = vi.fn().mockResolvedValue(directResponse);
    const proxyOptions = { enabled: true, url: "http://wall:8080" };

    const out = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", { method: "POST", body: "{}", directFetch }, proxyOptions);

    expect(out).toBe(directResponse);
    expect(directFetch).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", body: "{}", directFetch },
      "http://wall:8080",
    );
    // The transport owns TLS; no native dispatcher is built.
    expect(undiciMocks.ProxyAgent).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("passes null (not undefined) as the proxy arg on the direct path", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const directFetch = vi.fn().mockResolvedValue(new Response("ok"));
    await proxyAwareFetch("https://opencode.ai/x", { directFetch }, null);
    expect(directFetch).toHaveBeenCalledWith("https://opencode.ai/x", { directFetch }, null);
  });

  it("keeps the native dispatcher path when no directFetch is supplied", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const res = await proxyAwareFetch("https://opencode.ai/x", { method: "POST" }, { enabled: true, url: "http://wall:8080" });
    expect(await res.text()).toBe("native-ok");
    expect(undiciMocks.ProxyAgent).toHaveBeenCalledWith({ uri: "http://wall:8080" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][1].dispatcher).toBeTruthy();
  });
});
