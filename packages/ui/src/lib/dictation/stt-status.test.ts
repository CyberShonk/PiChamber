import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { fetchSttStatus, resetSttStatusCache } from "./stt-status"

// Self-contained: the real helper module with only the network stubbed
// (globalThis.fetch). No mock.module usage, so this file is safe under
// `bun test --isolate`.

const originalFetch = globalThis.fetch
const originalWindow = (globalThis as { window?: unknown }).window

let statusCalls = 0
let statusResponder: () => Response = () =>
  jsonResponse({
    config: { enabled: true, providerConfigId: "local", language: "", localModelId: "m1", providers: [] },
    models: [],
  })

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

const installFetchMock = (): void => {
  statusCalls = 0
  globalThis.fetch = mock(async (url: string) => {
    const parsed = new URL(String(url), "http://localhost")
    if (parsed.pathname === "/api/stt/status") {
      statusCalls += 1
      return statusResponder()
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

describe("fetchSttStatus shared memo", () => {
  beforeEach(() => {
    resetSttStatusCache()
    statusResponder = () =>
      jsonResponse({
        config: { enabled: true, providerConfigId: "local", language: "", localModelId: "m1", providers: [] },
        models: [],
      })
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreWindow()
    resetSttStatusCache()
  })

  test("concurrent composer and settings reads share one request", async () => {
    const results = await Promise.all([fetchSttStatus(), fetchSttStatus()])
    expect(results[0].config.enabled).toBe(true)
    expect(results[1].config.providerConfigId).toBe("local")
    expect(statusCalls).toBe(1)
  })

  test("sequential reads within the TTL reuse the settled memo", async () => {
    await fetchSttStatus()
    await fetchSttStatus()
    expect(statusCalls).toBe(1)
  })

  test("failure throws and never populates the memo", async () => {
    statusResponder = () => new Response(null, { status: 500 })
    await expect(fetchSttStatus()).rejects.toThrow("Could not load dictation settings")
    statusResponder = () =>
      jsonResponse({
        config: { enabled: false, providerConfigId: "local", language: "", localModelId: "m1", providers: [] },
        models: [],
      })
    const status = await fetchSttStatus()
    expect(status.config.enabled).toBe(false)
    expect(statusCalls).toBe(2)
  })

  test("fresh bypasses the memo for post-action refreshes and never populates it", async () => {
    await fetchSttStatus()
    statusResponder = () =>
      jsonResponse({
        config: { enabled: false, providerConfigId: "local", language: "", localModelId: "m1", providers: [] },
        models: [],
      })
    const fresh = await fetchSttStatus({ fresh: true })
    expect(fresh.config.enabled).toBe(false)
    // The explicit refresh did not replace the memo: the next background
    // read still observes the memoized snapshot.
    const memoized = await fetchSttStatus()
    expect(memoized.config.enabled).toBe(true)
    expect(statusCalls).toBe(2)
  })

  test("reset clears the memo for a runtime switch", async () => {
    await fetchSttStatus()
    resetSttStatusCache()
    await fetchSttStatus()
    expect(statusCalls).toBe(2)
  })

  test("a runtime switch misses the previous runtime's memo", async () => {
    await fetchSttStatus()
    setFakeRuntime("https://other-runtime.example")
    await fetchSttStatus()
    expect(statusCalls).toBe(2)
  })
})
