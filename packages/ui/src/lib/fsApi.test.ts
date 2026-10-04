import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { getFilesystemHome, getFilesystemHomeState, resetFilesystemHomeCache } from "./fsApi"
import { getProjectActionsState, getProjectDraftStarters } from "./pichamberConfig"
import { resolveFreshFilesystemHome } from "@/components/session/directoryExplorerTypes"

// Self-contained: real fsApi/pichamberConfig modules with only the network
// stubbed (globalThis.fetch), mirroring lib/pi/client.test.ts. No mock.module
// usage, so this file is safe under `bun test --isolate`.

const originalFetch = globalThis.fetch
const originalWindow = (globalThis as { window?: unknown }).window

let homeCalls = 0
let readCalls = 0
let homeResponder: () => Response = () =>
  jsonResponse({ home: "/home/tester", pichamberDataDir: "/home/tester/.config/pichamber" })

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

const installFetchMock = (): void => {
  homeCalls = 0
  readCalls = 0
  globalThis.fetch = mock(async (url: string) => {
    const parsed = new URL(String(url), "http://localhost")
    if (parsed.pathname === "/api/fs/home") {
      homeCalls += 1
      return homeResponder()
    }
    if (parsed.pathname === "/api/fs/read") {
      readCalls += 1
      return new Response(null, { status: 404 })
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

describe("getFilesystemHome boot dedup", () => {
  beforeEach(() => {
    resetFilesystemHomeCache()
    homeResponder = () =>
      jsonResponse({ home: "/home/tester", pichamberDataDir: "/home/tester/.config/pichamber" })
    installFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreWindow()
    resetFilesystemHomeCache()
  })

  test("concurrent calls share one request", async () => {
    const results = await Promise.all([getFilesystemHome(), getFilesystemHome(), getFilesystemHome()])
    expect(results).toEqual(["/home/tester", "/home/tester", "/home/tester"])
    expect(homeCalls).toBe(1)
  })

  test("sequential calls within the runtime reuse the settled memo", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(1)
  })

  test("failure never populates the memo", async () => {
    homeResponder = () => new Response(null, { status: 500 })
    expect(await getFilesystemHome()).toBeNull()
    homeResponder = () => jsonResponse({ home: "/home/tester" })
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(2)
  })

  test("null home never populates the memo", async () => {
    homeResponder = () => jsonResponse({})
    expect(await getFilesystemHome()).toBeNull()
    homeResponder = () => jsonResponse({ home: "/home/tester" })
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(2)
  })

  test("fresh bypasses the memo without poisoning it", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    homeResponder = () => jsonResponse({ home: "/home/elsewhere" })
    expect(await getFilesystemHome({ fresh: true })).toBe("/home/elsewhere")
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(2)
  })

  test("fresh failure leaves the settled memo intact", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    homeResponder = () => new Response(null, { status: 500 })
    expect(await getFilesystemHome({ fresh: true })).toBeNull()
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(2)
  })

  test("reset clears the memo for a runtime switch", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    resetFilesystemHomeCache()
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(2)
  })

  test("a runtime switch misses the previous runtime's memo", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    setFakeRuntime("https://other-runtime.example")
    homeResponder = () => jsonResponse({ home: "/home/other" })
    expect(await getFilesystemHome()).toBe("/home/other")
    expect(homeCalls).toBe(2)
  })

  test("project config readers reuse the directory store's home request", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    const project = { id: "proj", path: "/work/proj" }
    expect(await getProjectDraftStarters(project)).toEqual([])
    expect(await getProjectActionsState(project)).toEqual({ actions: [], primaryActionId: null })
    expect(homeCalls).toBe(1)
    // One user-config probe plus one legacy-config probe per reader.
    expect(readCalls).toBe(4)
  })

  test("the shared state carries pichamberDataDir for project config paths", async () => {
    const state = await getFilesystemHomeState()
    expect(state).toEqual({
      home: "/home/tester",
      pichamberDataDir: "/home/tester/.config/pichamber",
    })
    expect(homeCalls).toBe(1)
  })

  test("the explicit fresh resolver always hits the network", async () => {
    expect(await getFilesystemHome()).toBe("/home/tester")
    expect(await resolveFreshFilesystemHome()).toBe("/home/tester")
    expect(await resolveFreshFilesystemHome()).toBe("/home/tester")
    expect(homeCalls).toBe(3)
  })
})
