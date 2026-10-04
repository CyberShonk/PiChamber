import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { resetSessionOrdering } from '@/sync/session-ordering';

// First-attach transcript prefetch: `open()` with a known preferred session
// id starts one `getSession` up front, in flight while selectProject →
// health → listSessions resolve. The existence lookup (session missing from
// the list) and hydrate share that single response instead of issuing their
// own requests. Every consumer still runs today's validation on the reused
// response (generation, tombstone, stream-epoch checks).

const EPOCH = 'epoch-1';
const EPOCH_NEW = 'epoch-2';
const DIR = '/repo';
const OTHER_DIR = '/other';

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
  health: piClient.health.bind(piClient),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = async (count = 12) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

/** Deterministic bounded wait for an async condition (no fixed sleeps). */
const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return true;
};

const listItem = (id: string, directory: string) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 2 },
  updatedAt: 2,
});

const transcriptDetail = (id: string, directory: string, epoch: string, text: string) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 2 },
  messages: [
    {
      message: { id: `u-${id}`, sessionId: id, directory, role: 'user', createdAt: 1, text },
      parts: [],
    },
  ],
  lastSequence: 7,
  isStreaming: false,
  lifecycle: 'idle',
  streamEpoch: epoch,
});

const healthOk = (epoch: string) => ({
  state: 'ready' as const,
  protocolVersion: 1,
  capabilities: ['events.streamEpoch'],
  streamEpoch: epoch,
});

interface StoreInternal {
  streamEpoch: string | null;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

describe('first-attach transcript prefetch', () => {
  let store: PiSessionStore;
  let getSessionCalls: string[];

  beforeEach(() => {
    resetSessionOrdering();
    resetSessionActivityTiming();
    getSessionCalls = [];
    piClient.selectProject = (async (directory: string) => ({ directory })) as typeof piClient.selectProject;
    piClient.health = (async () => healthOk(EPOCH)) as typeof piClient.health;
    store = new PiSessionStore();
  });

  afterEach(() => {
    store.dispose();
    Object.assign(piClient, originals);
  });

  test('the transcript fetch starts before the list resolves and hydrate issues no second request', async () => {
    const listGate = deferred<{ sessions: ReturnType<typeof listItem>[]; streamEpoch: string }>();
    let listSettled = false;
    piClient.listSessions = (async () => {
      const result = await listGate.promise;
      listSettled = true;
      return result;
    }) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      return transcriptDetail(id, DIR, EPOCH, 'prefetched transcript');
    }) as unknown as typeof piClient.getSession;

    const opened = store.open(DIR, 's1');
    // The detail request is already in flight while the list is pending.
    expect(await waitFor(() => getSessionCalls.includes('s1'))).toBe(true);
    expect(listSettled).toBe(false);

    listGate.resolve({ sessions: [listItem('s1', DIR)], streamEpoch: EPOCH });
    await opened;

    expect(store.getState().selectedSessionId).toBe('s1');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(true);
    expect(store.getState().reducer.bySession.get('s1')?.messages.get('u-s1')?.text).toBe(
      'prefetched transcript',
    );
    // One shared request: the prefetch, reused by hydrate. No second fetch.
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(1);
  });

  test('a session missing from the list shares one request between lookup and hydrate', async () => {
    piClient.listSessions = (async () => ({
      sessions: [listItem('other', DIR)],
      streamEpoch: EPOCH,
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      if (id === 'other') return transcriptDetail(id, DIR, EPOCH, 'other transcript');
      return transcriptDetail(id, DIR, EPOCH, 'looked-up transcript');
    }) as unknown as typeof piClient.getSession;

    await store.open(DIR, 's1');

    expect(store.getState().selectedSessionId).toBe('s1');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(true);
    expect(store.getState().reducer.bySession.get('s1')?.messages.get('u-s1')?.text).toBe(
      'looked-up transcript',
    );
    expect(store.getState().sessions.map((item) => item.session.id)).toContain('s1');
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(1);
  });

  test('a directory mismatch on the prefetched lookup still takes the re-open path', async () => {
    piClient.listSessions = (async (scope: { directory?: string } = {}) => ({
      sessions: scope.directory === OTHER_DIR ? [listItem('s1', OTHER_DIR)] : [listItem('other', DIR)],
      streamEpoch: EPOCH,
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      if (id === 'other') return transcriptDetail(id, DIR, EPOCH, 'other transcript');
      return transcriptDetail(id, OTHER_DIR, EPOCH, 'moved transcript');
    }) as unknown as typeof piClient.getSession;

    await store.open(DIR, 's1');

    expect(store.getState().directory).toBe(OTHER_DIR);
    expect(store.getState().selectedSessionId).toBe('s1');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(true);
    // Lookup shared the first request; the re-opened attach fetched once more.
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(2);
  });

  test('a newer open generation discards the in-flight prefetch without committing it', async () => {
    const listByDirectory = new Map<string, Deferred<{ sessions: ReturnType<typeof listItem>[]; streamEpoch: string }>>();
    const detailById = new Map<string, Deferred<ReturnType<typeof transcriptDetail>>>();
    const listFor = (directory: string): Deferred<{ sessions: ReturnType<typeof listItem>[]; streamEpoch: string }> => {
      let gate = listByDirectory.get(directory);
      if (!gate) {
        gate = deferred();
        listByDirectory.set(directory, gate);
      }
      return gate;
    };
    const detailFor = (id: string): Deferred<ReturnType<typeof transcriptDetail>> => {
      let gate = detailById.get(id);
      if (!gate) {
        gate = deferred();
        detailById.set(id, gate);
      }
      return gate;
    };
    piClient.listSessions = ((scope: { directory?: string } = {}) =>
      listFor(scope.directory ?? DIR).promise) as unknown as typeof piClient.listSessions;
    piClient.getSession = ((id: string) => {
      getSessionCalls.push(id);
      return detailFor(id).promise;
    }) as unknown as typeof piClient.getSession;

    const first = store.open(DIR, 's1');
    expect(await waitFor(() => getSessionCalls.includes('s1'))).toBe(true);
    const second = store.open(OTHER_DIR, 's2');
    expect(await waitFor(() => getSessionCalls.includes('s2'))).toBe(true);

    listFor(OTHER_DIR).resolve({ sessions: [listItem('s2', OTHER_DIR)], streamEpoch: EPOCH });
    detailFor('s2').resolve(transcriptDetail('s2', OTHER_DIR, EPOCH, 'second transcript'));
    await second;

    expect(store.getState().selectedSessionId).toBe('s2');
    expect(store.getState().hydratedSessionIds.has('s2')).toBe(true);

    // The stale first attach settles after its generation was superseded:
    // its list and its prefetch commit nothing.
    listFor(DIR).resolve({ sessions: [listItem('s1', DIR)], streamEpoch: EPOCH });
    detailFor('s1').resolve(transcriptDetail('s1', DIR, EPOCH, 'stale transcript'));
    await first;

    expect(store.getState().selectedSessionId).toBe('s2');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(false);
    expect(store.getState().reducer.bySession.has('s1')).toBe(false);
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(1);
  });

  test('an invalid-session prefetch rejection runs the normal missing-session cleanup', async () => {
    piClient.listSessions = (async () => ({
      sessions: [listItem('other', DIR)],
      streamEpoch: EPOCH,
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      if (id === 's1') throw new PiRequestError('INVALID_SESSION', 'gone');
      return transcriptDetail(id, DIR, EPOCH, 'other transcript');
    }) as unknown as typeof piClient.getSession;

    await store.open(DIR, 's1');

    expect(store.isDeleted('s1')).toBe(true);
    expect(store.getState().selectedSessionId).toBe('other');
    expect(store.getState().sessionLoadErrorById.has('s1')).toBe(false);
    expect(store.getState().hydratedSessionIds.has('other')).toBe(true);
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(1);
  });

  test('a transient prefetch rejection surfaces the same hydrate failure as today', async () => {
    piClient.listSessions = (async () => ({
      sessions: [listItem('s1', DIR)],
      streamEpoch: EPOCH,
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      throw new PiRequestError('DAEMON_REQUEST_FAILED', 'boom');
    }) as unknown as typeof piClient.getSession;

    await store.open(DIR, 's1');

    // Same failure hydrate reports today when its own transcript fetch
    // fails: a cluster-level error, not a silent empty chat.
    expect(store.getState().connection).toBe('error');
    expect(store.getState().error?.message).toContain('boom');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(false);
  });

  test('an unconsumed prefetch rejection after reset never surfaces as unhandled', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const listGate = deferred<{ sessions: ReturnType<typeof listItem>[]; streamEpoch: string }>();
    const detailGate = deferred<ReturnType<typeof transcriptDetail>>();
    try {
      piClient.listSessions = (() => listGate.promise) as unknown as typeof piClient.listSessions;
      piClient.getSession = ((id: string) => {
        getSessionCalls.push(id);
        return detailGate.promise;
      }) as unknown as typeof piClient.getSession;

      const opened = store.open(DIR, 's1');
      expect(await waitFor(() => getSessionCalls.includes('s1'))).toBe(true);
      // Runtime reset drops the prefetch before anyone consumes it.
      store.clear();
      detailGate.reject(new PiRequestError('INVALID_SESSION', 'gone'));
      listGate.resolve({ sessions: [listItem('s1', DIR)], streamEpoch: EPOCH });
      await opened;
      await tick();

      expect(rejections).toEqual([]);
      expect(store.isDeleted('s1')).toBe(false);
      expect(store.getState().selectedSessionId).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a prefetch stamped with a retired epoch is not committed; hydrate refetches', async () => {
    // The store already lives on epoch-1; health reports epoch-2, so the
    // prefetch issued before health belongs to a retired lifetime.
    internal(store).streamEpoch = EPOCH;
    let calls = 0;
    piClient.health = (async () => healthOk(EPOCH_NEW)) as typeof piClient.health;
    piClient.listSessions = (async () => ({
      sessions: [listItem('s1', DIR)],
      streamEpoch: EPOCH_NEW,
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async (id: string) => {
      getSessionCalls.push(id);
      calls += 1;
      if (calls === 1) return transcriptDetail(id, DIR, EPOCH, 'stale transcript');
      return transcriptDetail(id, DIR, EPOCH_NEW, 'fresh transcript');
    }) as unknown as typeof piClient.getSession;

    await store.open(DIR, 's1');

    expect(internal(store).streamEpoch).toBe(EPOCH_NEW);
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(true);
    expect(store.getState().reducer.bySession.get('s1')?.messages.get('u-s1')?.text).toBe(
      'fresh transcript',
    );
    expect(getSessionCalls.filter((id) => id === 's1')).toHaveLength(2);
  });
});
