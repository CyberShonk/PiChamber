import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { runtimeFetch } from "./runtime-fetch"

// Self-contained: the real runtimeFetch with only the network stubbed
// (globalThis.fetch). Locks in that `/api/pi/runtime` joins the concurrent
// read-coalescing allowlist so boot health probes merge into one request.

const originalFetch = globalThis.fetch

let runtimeCalls = 0

const installFetchMock = (): void => {
  runtimeCalls = 0
  globalThis.fetch = mock(async (url: string) => {
    const parsed = new URL(String(url), "http://localhost")
    if (parsed.pathname === "/api/pi/runtime") {
      runtimeCalls += 1
      return new Response(JSON.stringify({ state: "ready", protocolVersion: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(null, { status: 500 })
  }) as unknown as typeof fetch
}

describe("runtimeFetch read coalescing", () => {
  beforeEach(() => {
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("concurrent daemon health GETs share one request with independent bodies", async () => {
    const [first, second] = await Promise.all([
      runtimeFetch("/api/pi/runtime"),
      runtimeFetch("/api/pi/runtime"),
    ])
    expect(runtimeCalls).toBe(1)
    expect(await first.json()).toEqual({ state: "ready", protocolVersion: 1 })
    expect(await second.json()).toEqual({ state: "ready", protocolVersion: 1 })
  })

  test("requests carrying a signal never coalesce", async () => {
    const controller = new AbortController()
    await Promise.all([
      runtimeFetch("/api/pi/runtime", { signal: controller.signal }),
      runtimeFetch("/api/pi/runtime"),
    ])
    expect(runtimeCalls).toBe(2)
  })

  test("non-GET health requests never coalesce", async () => {
    await Promise.all([
      runtimeFetch("/api/pi/runtime", { method: "POST" }),
      runtimeFetch("/api/pi/runtime", { method: "POST" }),
    ])
    expect(runtimeCalls).toBe(2)
  })
})
