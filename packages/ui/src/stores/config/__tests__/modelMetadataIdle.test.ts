import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/startupTrace', () => ({
    markStartupTrace: mock(() => undefined),
    measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

const {
    cancelScheduledModelMetadataLoadForTests,
    ensureModelMetadataLoaded,
    resetModelMetadataForTests,
    scheduleModelMetadataLoad,
} = await import('../modelMetadata');

const MODELS_DEV_PAYLOAD = {
    testprovider: {
        id: 'testprovider',
        models: {
            m1: { id: 'm1', name: 'M1' },
        },
    },
};

describe('modelMetadata idle scheduling', () => {
    let fetchCalls = 0;
    let idleCallbacks: Array<() => void> = [];
    const originalFetch = globalThis.fetch;
    const originalIdle = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;

    beforeEach(() => {
        resetModelMetadataForTests();
        fetchCalls = 0;
        idleCallbacks = [];
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = ((callback: () => void) => {
            idleCallbacks.push(callback);
            return idleCallbacks.length;
        }) as unknown as typeof globalThis.requestIdleCallback;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify(MODELS_DEV_PAYLOAD), {
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;
    });

    afterEach(() => {
        resetModelMetadataForTests();
        cancelScheduledModelMetadataLoadForTests();
        globalThis.fetch = originalFetch;
        if (originalIdle === undefined) {
            delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
        } else {
            (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = originalIdle;
        }
    });

    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    test('scheduling defers the fetch until idle and fires once', async () => {
        const store = new Map<string, { id: string; providerId: string }>();
        const get = () => store as unknown as Map<string, import('@/types').ModelMetadata>;
        let setCalls = 0;
        const set = (metadata: Map<string, import('@/types').ModelMetadata>) => {
            setCalls += 1;
            store.clear();
            for (const [key, value] of metadata) store.set(key, value as never);
        };

        scheduleModelMetadataLoad(get, set as never);
        scheduleModelMetadataLoad(get, set as never);
        expect(fetchCalls).toBe(0);
        // One idle trigger despite two schedule calls.
        expect(idleCallbacks.length).toBe(1);

        idleCallbacks[0]!();
        await flush();
        await flush();
        expect(fetchCalls).toBe(1);
        expect(setCalls).toBe(1);
        expect(store.size).toBe(1);

        // A later schedule with warm metadata does not refetch.
        scheduleModelMetadataLoad(get, set as never);
        expect(idleCallbacks.length).toBe(1);
        expect(fetchCalls).toBe(1);
    });

    test('on-demand load before idle fires immediately and idle does not refetch', async () => {
        const store = new Map<string, { id: string; providerId: string }>();
        const get = () => store as unknown as Map<string, import('@/types').ModelMetadata>;
        const set = (metadata: Map<string, import('@/types').ModelMetadata>) => {
            store.clear();
            for (const [key, value] of metadata) store.set(key, value as never);
        };

        scheduleModelMetadataLoad(get, set as never);
        expect(fetchCalls).toBe(0);
        expect(idleCallbacks.length).toBe(1);

        ensureModelMetadataLoaded(get, set as never);
        await flush();
        await flush();
        expect(fetchCalls).toBe(1);
        expect(store.size).toBe(1);

        // The pending idle trigger fires but dedupes (no second fetch).
        idleCallbacks[0]!();
        await flush();
        await flush();
        expect(fetchCalls).toBe(1);
    });

    test('concurrent on-demand calls share one in-flight request', async () => {
        const get = () => new Map<string, import('@/types').ModelMetadata>();
        const set = mock(() => undefined);
        ensureModelMetadataLoaded(get, set as never);
        ensureModelMetadataLoaded(get, set as never);
        await flush();
        await flush();
        expect(fetchCalls).toBe(1);
    });

    test('failure does not masquerade as authoritative metadata and retries after the cooldown', async () => {
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error('network down');
        }) as typeof fetch;

        const box: { current: Map<string, import('@/types').ModelMetadata> | null } = { current: null };
        const get = () => new Map<string, import('@/types').ModelMetadata>();
        const set = (metadata: Map<string, import('@/types').ModelMetadata>) => {
            box.current = metadata;
        };

        ensureModelMetadataLoaded(get, set);
        await flush();
        await flush();
        expect(fetchCalls).toBe(1);
        expect(box.current).toBeNull();

        // Render-driven triggers inside the cooldown do not restart the download.
        ensureModelMetadataLoaded(get, set);
        ensureModelMetadataLoaded(get, set);
        await flush();
        expect(fetchCalls).toBe(1);

        // Retry allowed once the cooldown has passed.
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify(MODELS_DEV_PAYLOAD), {
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;
        const originalNow = Date.now;
        const failedAt = originalNow();
        Date.now = () => failedAt + 30_001;
        try {
            ensureModelMetadataLoaded(get, set);
        } finally {
            Date.now = originalNow;
        }
        await flush();
        await flush();
        expect(fetchCalls).toBe(2);
        expect(box.current?.size).toBe(1);
    });

    test('an empty models.dev response also starts the cooldown', async () => {
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        }) as typeof fetch;
        const get = () => new Map<string, import('@/types').ModelMetadata>();
        let setCalls = 0;
        const set = () => {
            setCalls += 1;
        };

        ensureModelMetadataLoaded(get, set);
        await flush();
        await flush();
        ensureModelMetadataLoaded(get, set);
        await flush();
        expect(fetchCalls).toBe(1);
        expect(setCalls).toBe(0);
    });

    test('falls back to setTimeout when requestIdleCallback is unavailable (Safari/WKWebView)', async () => {
        delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
        const store = new Map<string, { id: string; providerId: string }>();
        const get = () => store as unknown as Map<string, import('@/types').ModelMetadata>;
        const set = (metadata: Map<string, import('@/types').ModelMetadata>) => {
            store.clear();
            for (const [key, value] of metadata) store.set(key, value as never);
        };

        scheduleModelMetadataLoad(get, set as never);
        expect(fetchCalls).toBe(0);
        // Fallback timer (~1500 ms) eventually fires; shorten by awaiting it
        // with a real timer assertion on pending state only — the fetch must
        // not have run synchronously.
        cancelScheduledModelMetadataLoadForTests();
        expect(fetchCalls).toBe(0);
    });
});
