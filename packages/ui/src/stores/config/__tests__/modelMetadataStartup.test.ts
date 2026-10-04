import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DIRECTORY = '/workspace/project';

let storage = new Map<string, string>();
const makeStorage = (): Storage => ({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
        storage.set(key, value);
    },
    removeItem: (key: string) => {
        storage.delete(key);
    },
    clear: () => {
        storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
        return storage.size;
    },
}) as Storage;

let listProvidersCalls = 0;
let metadataFetchCalls = 0;

mock.module('@/stores/utils/safeStorage', () => ({
    getDeferredSafeStorage: () => makeStorage(),
    getSafeStorage: () => makeStorage(),
    createDeferredSafeJSONStorage: () => {
        const testStorage = makeStorage();
        return {
            getItem: (name: string) => {
                const value = testStorage.getItem(name);
                return value === null ? null : JSON.parse(value);
            },
            setItem: (name: string, value: unknown) => {
                testStorage.setItem(name, JSON.stringify(value));
            },
            removeItem: (name: string) => {
                testStorage.removeItem(name);
            },
        };
    },
}));

mock.module('@/stores/useProjectsStore', () => ({
    useProjectsStore: {
        getState: () => ({
            activeProjectId: 'project',
            projects: [{ id: 'project', path: DIRECTORY, label: 'Project' }],
        }),
    },
}));

mock.module('@/lib/pi/client', () => ({
    PiRequestError: class PiRequestError extends Error {
        code: string;
        constructor(code: string, message?: string) {
            super(message ?? code);
            this.code = code;
        }
    },
    piClient: {
        setDirectory: mock(() => undefined),
        health: mock(async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] })),
        listProviders: mock(async () => {
            listProvidersCalls += 1;
            return {
                providers: [{
                    id: 'live',
                    label: 'live',
                    authenticated: true,
                    models: [{
                        id: 'live-model',
                        label: 'live-model',
                        providerId: 'live',
                        supportsThinking: false,
                        thinkingLevels: [],
                    }],
                }],
                default: { providerId: 'live', modelId: 'live-model' },
            };
        }),
        getSettings: mock(async () => ({ pichamber: {} })),
    },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
    getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: mock(async () => new Response(JSON.stringify({}), {
        headers: { 'Content-Type': 'application/json' },
    })),
}));

mock.module('@/lib/persistence', () => ({
    updateDesktopSettings: mock(async () => undefined),
    loadSharedSettingsDocument: mock(async () => null),
}));

mock.module('@/lib/startupTrace', () => ({
    markStartupTrace: mock(() => undefined),
    measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
    emitConfigChange: mock(() => undefined),
    scopeMatches: mock(() => false),
    subscribeToConfigChanges: mock(() => () => undefined),
}));

mock.module('@/sync/sync-refs', () => ({
    getSyncSessions: () => [],
    getAllSyncSessions: () => [],
    getSyncSessionDirectory: () => null,
    getActiveSyncSessions: () => [],
    getSyncMessages: () => [],
    getSyncParts: () => [],
}));

const { useConfigStore } = await import('../..//useConfigStore');
const { resetModelMetadataForTests } = await import('../modelMetadata');

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('modelMetadata startup path', () => {
    beforeEach(() => {
        storage = new Map<string, string>();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: makeStorage(),
        });
        listProvidersCalls = 0;
        metadataFetchCalls = 0;
        resetModelMetadataForTests();
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('models.dev')) {
                metadataFetchCalls += 1;
                return new Response(JSON.stringify({
                    live: { id: 'live', models: { 'live-model': { id: 'live-model' } } },
                }), { headers: { 'Content-Type': 'application/json' } });
            }
            return new Response(JSON.stringify({}), {
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch;
        useConfigStore.setState({
            activeDirectoryKey: DIRECTORY,
            directoryScoped: {},
            providers: [],
            defaultProviders: {},
            currentProviderId: '',
            currentModelId: '',
            currentVariant: undefined,
            selectedProviderId: '',
            selectionSource: 'auto',
            isConnected: true,
            isInitialized: false,
            modelsMetadata: new Map(),
        });
    });

    test('loadProviders no longer triggers the metadata fetch synchronously', async () => {
        await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:startup' });
        await flush();
        expect(listProvidersCalls).toBe(1);
        expect(useConfigStore.getState().providers.map((entry) => entry.id)).toEqual(['live']);
        // The models.dev download is idle-deferred now, not part of the
        // startup provider load.
        expect(metadataFetchCalls).toBe(0);
    });

    test('on-demand metadata read triggers the fetch immediately', async () => {
        await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:ondemand' });
        expect(metadataFetchCalls).toBe(0);

        useConfigStore.getState().getModelMetadata('live', 'live-model');
        await flush();
        await flush();
        expect(metadataFetchCalls).toBe(1);
        expect(useConfigStore.getState().modelsMetadata.size).toBe(1);
    });
});
