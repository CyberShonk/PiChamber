import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { fetchPiRuntimeHealth, resetPiRuntimeHealthCache } from "./transport"

// Self-contained: the real transport module with only the network stubbed
// (globalThis.fetch). No mock.module usage, so this file is safe under
// `bun test --isolate`.

const originalFetch = globalThis.fetch
const originalWindow = (globalThis as { window?: unknown }).window

let runtimeCalls = 0
let runtimeResponder: () => Response = () =>
  jsonResponse({
    state: "ready",
    protocolVersion: 1,
    capabilities: ["events.streamEpoch"],
    streamEpoch: "epoch-1",
  })

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

const installFetchMock = (): void => {
  runtimeCalls = 0
  globalThis.fetch = mock(async (url: string) => {
    const parsed = new URL(String(url), "http://localhost")
    if (parsed.pathname === "/api/pi/runtime") {
      runtimeCalls += 1
      return runtimeResponder()
    }
    return new Response(null, { status: 500 })
  }) as unknown as typeof fetch
}

const setFakeRuntime = (apiBaseUrl: string): void => {
  (globalThis as Record<string, unknown>).window = {
    __PICHAMBER_API_BASE_URL__: apiBaseUrl,
    location: { protocol: "https:", origin: apiBaseUrl, href: `${apiBaseUrl}/` },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
}

const restoreWindow = (): void => {
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow
  }
}

describe("fetchPiRuntimeHealth boot memo", () => {
  beforeEach(() => {
    resetPiRuntimeHealthCache()
    runtimeResponder = () =>
      jsonResponse({
        state: "ready",
        protocolVersion: 1,
        capabilities: ["events.streamEpoch"],
        streamEpoch: "epoch-1",
      })
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreWindow()
    resetPiRuntimeHealthCache()
  })

  test("concurrent boot probes share one request", async () => {
    const results = await Promise.all([
      fetchPiRuntimeHealth(),
      fetchPiRuntimeHealth(),
      fetchPiRuntimeHealth(),
    ])
    for (const result of results) {
      expect(result.state).toBe("ready")
      expect(result.streamEpoch).toBe("epoch-1")
    }
    expect(runtimeCalls).toBe(1)
  })

  test("sequential probes within the TTL reuse the settled ready memo", async () => {
    expect((await fetchPiRuntimeHealth()).state).toBe("ready")
    expect((await fetchPiRuntimeHealth()).state).toBe("ready")
    expect(runtimeCalls).toBe(1)
  })

  test("unavailable results never populate the memo", async () => {
    runtimeResponder = () => jsonResponse({ error: { code: "DAEMON_UNAVAILABLE" } }, { status: 503 })
    expect((await fetchPiRuntimeHealth()).state).toBe("unavailable")
    expect((await fetchPiRuntimeHealth()).state).toBe("unavailable")
    expect(runtimeCalls).toBe(2)
  })

  test("protocol mismatch never populates the memo", async () => {
    runtimeResponder = () => new Response("not-json", { status: 200 })
    const first = await fetchPiRuntimeHealth()
    expect(first.state).toBe("unavailable")
    expect(first.error?.code).toBe("DAEMON_PROTOCOL_MISMATCH")
    runtimeResponder = () =>
      jsonResponse({ state: "ready", protocolVersion: 1, capabilities: [], streamEpoch: "epoch-2" })
    const second = await fetchPiRuntimeHealth()
    expect(second.state).toBe("ready")
    expect(second.streamEpoch).toBe("epoch-2")
    expect(runtimeCalls).toBe(2)
  })

  test("fresh bypasses the memo for recovery probing and never populates it", async () => {
    expect((await fetchPiRuntimeHealth()).streamEpoch).toBe("epoch-1")
    runtimeResponder = () =>
      jsonResponse({ state: "ready", protocolVersion: 1, capabilities: [], streamEpoch: "epoch-2" })
    // Recovery path: observes the live daemon despite the warm boot memo.
    expect((await fetchPiRuntimeHealth(undefined, undefined, { fresh: true })).streamEpoch).toBe("epoch-2")
    // The fresh read did not replace the boot memo.
    expect((await fetchPiRuntimeHealth()).streamEpoch).toBe("epoch-1")
    expect(runtimeCalls).toBe(2)
  })

  test("reset clears the memo for a runtime switch", async () => {
    expect((await fetchPiRuntimeHealth()).state).toBe("ready")
    resetPiRuntimeHealthCache()
    expect((await fetchPiRuntimeHealth()).state).toBe("ready")
    expect(runtimeCalls).toBe(2)
  })

  test("a runtime switch misses the previous runtime's memo", async () => {
    expect((await fetchPiRuntimeHealth()).streamEpoch).toBe("epoch-1")
    setFakeRuntime("https://other-runtime.example")
    runtimeResponder = () =>
      jsonResponse({ state: "ready", protocolVersion: 1, capabilities: [], streamEpoch: "epoch-other" })
    expect((await fetchPiRuntimeHealth()).streamEpoch).toBe("epoch-other")
    expect(runtimeCalls).toBe(2)
  })
})
