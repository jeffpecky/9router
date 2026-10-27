import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyAwareFetchMock, opencodeTlsFetchMock } = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  opencodeTlsFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyAwareFetchMock,
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: opencodeTlsFetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function makeArgs() {
  return {
    model: "nemotron-3-ultra-free",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: makeCredentials(),
    providerSessionId: "conversation-tunnel-test",
    clientTool: "claude",
  };
}

beforeEach(() => {
  proxyAwareFetchMock.mockReset();
  opencodeTlsFetchMock.mockReset();
  // proxyAwareFetch owns the transport contract; here it is a pure pass-through
  // so the executor's handoff shape is what these tests observe (#5275).
  proxyAwareFetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  // Green Response for the outbound legs the mock drives in the tests below.
  opencodeTlsFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
});

describe("OpenCodeExecutor impersonated-TLS transport (#5275)", () => {
  it("passes a tunnelsProxyUrl transport to proxyAwareFetch", async () => {
    const executor = getExecutor("opencode");
    const proxyOptions = { enabled: true, url: "http://pool:3128" };
    let captured;

    proxyAwareFetchMock.mockImplementation(async (url, options, passedProxyOptions) => {
      captured = { directFetch: options.directFetch, proxyOptions: passedProxyOptions };
      return new Response("{}", { status: 200 });
    });

    const result = await executor.execute({ ...makeArgs(), proxyOptions });

    expect(result.response.status).toBe(200);
    // The transport is handed over, never invoked here: the mock stands in for
    // proxyFetch, which is the only caller of directFetch.
    expect(opencodeTlsFetchMock).not.toHaveBeenCalled();
    expect(captured.directFetch).toBeTypeOf("function");
    // Only transports that actually tunnel may set the flag — proxyFetch
    // tunnels a proxied call natively otherwise.
    expect(captured.directFetch.tunnelsProxyUrl).toBe(true);
    expect(proxyAwareFetchMock.mock.calls[0][1].directFetch).toBe(captured.directFetch);
    // The executor forwards proxyOptions into the third position unchanged.
    expect(proxyAwareFetchMock.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("forwards the resolved proxy URL into the impersonated client", async () => {
    const executor = getExecutor("opencode");
    let upstreamSignal;

    proxyAwareFetchMock.mockImplementation(async (url, options, passedProxyOptions) => {
      upstreamSignal = options.signal;
      // Mirror fetchWithTlsFallback's contract: the resolved proxy URL rides a
      // third argument (null on the direct leg), and the transport sees the
      // caller's signal as the same instance.
      const stubOptions = { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: options.signal };
      const directLeg = await options.directFetch("https://opencode.ai/direct", stubOptions, null);
      const tunnelLeg = await options.directFetch("https://opencode.ai/tunnel", stubOptions, "http://pool:3128");
      expect(directLeg.status).toBe(200);
      expect(tunnelLeg.status).toBe(200);
      return new Response("{}", { status: 200 });
    });

    const result = await executor.execute({ ...makeArgs(), proxyOptions: { enabled: true, url: "http://pool:3128" } });

    expect(result.response.status).toBe(200);
    expect(opencodeTlsFetchMock).toHaveBeenCalledTimes(2);
    const [direct, tunnel] = opencodeTlsFetchMock.mock.calls;

    // Arg 2 must be explicit fields only. proxyAwareFetch's options carry
    // directFetch itself, so a re-spread would recurse into patchedFetch.
    expect(direct[0]).toBe("https://opencode.ai/direct");
    expect(direct[1]).toEqual({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect("directFetch" in direct[1]).toBe(false);
    expect(direct[2].signal).toBe(upstreamSignal);
    expect(direct[2]).toEqual({ signal: upstreamSignal, proxyUrl: null });

    expect(tunnel[0]).toBe("https://opencode.ai/tunnel");
    expect(tunnel[1]).toEqual({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect("directFetch" in tunnel[1]).toBe(false);
    expect(tunnel[2].signal).toBe(upstreamSignal);
    expect(tunnel[2]).toEqual({ signal: upstreamSignal, proxyUrl: "http://pool:3128" });
  });

  it("still tunnels on the unproxied path", async () => {
    const executor = getExecutor("opencode");
    let captured;

    proxyAwareFetchMock.mockImplementation(async (url, options, passedProxyOptions) => {
      captured = { directFetch: options.directFetch, proxyOptions: passedProxyOptions };
      return new Response("{}", { status: 200 });
    });

    const result = await executor.execute(makeArgs());

    expect(result.response.status).toBe(200);
    expect(proxyAwareFetchMock.mock.calls[0][2]).toBeNull();
    // Direct-path identity is unchanged: the same flagged transport object is
    // handed over whether or not a proxy resolves.
    expect(captured.directFetch).toBeTypeOf("function");
    expect(captured.directFetch.tunnelsProxyUrl).toBe(true);
  });
});
