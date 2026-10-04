import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  PiService,
  PiRequestError,
  invalidateResourcesCache,
} from "@/lib/pi/client";

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const resourcesPayload = (tag: string) => ({
  skills: [{ id: "skill-1", kind: "skill", name: `skill-${tag}`, location: "project" }],
  prompts: [
    { id: "p1", kind: "prompt", name: `review-${tag}`, location: "global", editable: true },
  ],
  agents: [],
});

let resourceCalls = 0;
let failResources = false;
let failMutations = false;

const installFetchMock = () => {
  calls.length = 0;
  resourceCalls = 0;
  const fn = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/pi/resources" && init?.method === "GET") {
      resourceCalls += 1;
      if (failResources) {
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
      }
      return jsonResponse(resourcesPayload(`call-${resourceCalls}`));
    }
    if (parsed.pathname === "/api/pi/resources/skill-1" && init?.method === "PUT") {
      if (failMutations) {
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
      }
      return jsonResponse(resourcesPayload("mutated"));
    }
    if (parsed.pathname === "/api/pi/resources/prompts" && init?.method === "POST") {
      if (failMutations) {
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
      }
      return jsonResponse(resourcesPayload("mutated"));
    }
    if (parsed.pathname === "/api/pi/resources/prompts/p1" && (init?.method === "PUT" || init?.method === "DELETE")) {
      if (failMutations) {
        return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
      }
      return jsonResponse(resourcesPayload("mutated"));
    }
    return jsonResponse({ error: { code: "DAEMON_REQUEST_FAILED" } }, { status: 500 });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
};

describe("piClient listResources memo", () => {
  beforeEach(() => {
    failResources = false;
    failMutations = false;
    installFetchMock();
    invalidateResourcesCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateResourcesCache();
  });

  test("two sequential loads for the same scope issue one request", async () => {
    const client = new PiService();
    const first = await client.listResources("/work-seq");
    const second = await client.listResources("/work-seq");
    expect(resourceCalls).toBe(1);
    expect(second).toEqual(first);
    expect(calls[0].url).toBe("/api/pi/resources?directory=%2Fwork-seq");
  });

  test("concurrent loads share one in-flight request", async () => {
    const client = new PiService();
    const [first, second] = await Promise.all([
      client.listResources("/work-join"),
      client.listResources("/work-join"),
    ]);
    expect(resourceCalls).toBe(1);
    expect(second).toEqual(first);
  });

  test("different directories are separate scopes with unchanged query wiring", async () => {
    const client = new PiService();
    await client.listResources("/scope-a");
    await client.listResources("/scope-b");
    expect(resourceCalls).toBe(2);
    expect(calls[0].url).toBe("/api/pi/resources?directory=%2Fscope-a");
    expect(calls[1].url).toBe("/api/pi/resources?directory=%2Fscope-b");
    await client.listResources("/scope-a");
    await client.listResources("/scope-b");
    expect(resourceCalls).toBe(2);
  });

  test("failures never populate the memo", async () => {
    const client = new PiService();
    failResources = true;
    await expect(client.listResources("/work-fail")).rejects.toBeInstanceOf(PiRequestError);
    await expect(client.listResources("/work-fail")).rejects.toBeInstanceOf(PiRequestError);
    expect(resourceCalls).toBe(2);
    failResources = false;
    const result = await client.listResources("/work-fail");
    expect(resourceCalls).toBe(3);
    expect(result.prompts).toHaveLength(1);
  });

  test("resource mutations invalidate the memo", async () => {
    const client = new PiService();
    const directory = "/work-mut";
    await client.listResources(directory);
    expect(resourceCalls).toBe(1);

    await client.updateResource({ resourceId: "skill-1", content: "updated" });
    await client.listResources(directory);
    expect(resourceCalls).toBe(2);

    await client.createPromptTemplate(
      { name: "review", description: "Review", content: "Do it", location: "global" },
      directory,
    );
    await client.listResources(directory);
    expect(resourceCalls).toBe(3);

    await client.updatePromptTemplate("p1", { description: "New" }, directory);
    await client.listResources(directory);
    expect(resourceCalls).toBe(4);

    await client.deletePromptTemplate("p1", directory);
    await client.listResources(directory);
    expect(resourceCalls).toBe(5);
  });

  test("failed mutations do not invalidate the memo", async () => {
    const client = new PiService();
    const directory = "/work-mut-fail";
    await client.listResources(directory);
    expect(resourceCalls).toBe(1);
    failMutations = true;
    await expect(
      client.updateResource({ resourceId: "skill-1", content: "updated" }),
    ).rejects.toBeInstanceOf(PiRequestError);
    await client.listResources(directory);
    expect(resourceCalls).toBe(1);
  });

  test("memoized results are independent clones, never shared-mutable", async () => {
    const client = new PiService();
    const directory = "/work-clone";
    const first = await client.listResources(directory);
    first.prompts.push({ id: "evil", kind: "prompt", name: "evil", location: "global" });
    first.skills[0].name = "mutated";
    const second = await client.listResources(directory);
    expect(resourceCalls).toBe(1);
    expect(second.prompts).toHaveLength(1);
    expect(second.skills[0].name).toBe("skill-call-1");
    const third = await client.listResources(directory);
    expect(third.prompts).toHaveLength(1);
    expect(third).not.toBe(second);
  });

  test("reload bypasses the settled memo and repopulates it", async () => {
    const client = new PiService();
    const directory = "/work-reload";
    const first = await client.listResources(directory);
    expect(resourceCalls).toBe(1);
    const reloaded = await client.listResources(directory, { reload: true });
    expect(resourceCalls).toBe(2);
    expect(reloaded.prompts[0].name).toBe("review-call-2");
    expect(first.prompts[0].name).toBe("review-call-1");
    const again = await client.listResources(directory);
    expect(resourceCalls).toBe(2);
    expect(again.prompts[0].name).toBe("review-call-2");
  });

  test("expired memo entries refetch", async () => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      const client = new PiService();
      await client.listResources("/work-ttl");
      expect(resourceCalls).toBe(1);
      await client.listResources("/work-ttl");
      expect(resourceCalls).toBe(1);
      offset = 6_000;
      await client.listResources("/work-ttl");
      expect(resourceCalls).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("a runtime switch isolates memoized scopes", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const stubWindow = (apiBaseUrl: string) => {
      (globalThis as Record<string, unknown>).window = {
        location: { origin: "http://localhost", href: "http://localhost/" },
        __PICHAMBER_API_BASE_URL__: apiBaseUrl,
      };
    };
    try {
      const client = new PiService();
      stubWindow("https://rt-a.test");
      await client.listResources("/work-rt");
      await client.listResources("/work-rt");
      expect(resourceCalls).toBe(1);
      stubWindow("https://rt-b.test");
      const switched = await client.listResources("/work-rt");
      expect(resourceCalls).toBe(2);
      expect(switched.prompts[0].name).toBe("review-call-2");
      await client.listResources("/work-rt");
      expect(resourceCalls).toBe(2);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
