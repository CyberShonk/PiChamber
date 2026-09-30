import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  compareSessionsByLifecycleOrder,
  createSessionLifecycleComparator,
  observeSessionActivityEvent,
  orderSessionsByLifecycleScopes,
  removeSessionOrdering,
  resetSessionOrdering,
  useSessionOrderingStore,
  raiseSessionOrderingBaselines,
} from './session-ordering';

const session = (
  id: string,
  updated: number,
  parentID?: string,
): Session => ({
  id,
  parentID,
  time: { created: updated - 1, updated },
} as Session);

beforeEach(() => resetSessionOrdering());

describe('session lifecycle ordering', () => {
  test('promotes only on a new active (prompt) observation', () => {
    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);

    observeSessionActivityEvent('session-a', 'active');
    const activeRank = useSessionOrderingStore.getState().rankById.get('session-a');
    expect(typeof activeRank).toBe('number');

    observeSessionActivityEvent('session-a', 'active');
    expect(useSessionOrderingStore.getState().rankById.get('session-a')).toBe(activeRank);

    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.get('session-a')).toBe(activeRank);
  });

  test('treats an active event without a snapshot baseline as a real transition', () => {
    observeSessionActivityEvent('session-a', 'active');

    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(true);
  });

  test('uses lifecycle rank only within the same parent scope', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const childOlder = session('child-older', 10, 'root-older');
    const childNewer = session('child-newer', 20, 'root-older');
    const otherParentChild = session('other-parent-child', 20, 'root-newer');
    const rankById = new Map([
      ['child-older', 100],
      ['root-older', 90],
    ]);

    expect(compareSessionsByLifecycleOrder(rootOlder, rootNewer, new Set(), rankById)).toBeLessThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, childNewer, new Set(), rankById)).toBeLessThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, otherParentChild, new Set(), rankById)).toBeGreaterThan(0);
    expect(compareSessionsByLifecycleOrder(childOlder, rootNewer, new Set(), rankById)).toBeGreaterThan(0);
  });

  test('freezes timestamp fallback until a lifecycle transition', () => {
    const older = session('older', 10);
    const newer = session('newer', 20);
    expect(compareSessionsByLifecycleOrder(older, newer, new Set(), new Map())).toBeGreaterThan(0);

    const metadataOnlyUpdate = session('older', 30);
    expect(compareSessionsByLifecycleOrder(metadataOnlyUpdate, newer, new Set(), new Map())).toBeGreaterThan(0);

    expect(compareSessionsByLifecycleOrder(
      metadataOnlyUpdate,
      newer,
      new Set(),
      new Map([['older', 40]]),
    )).toBeLessThan(0);
  });

  test('clears lifecycle state when a session is deleted', () => {
    observeSessionActivityEvent('session-a', 'active');
    removeSessionOrdering('session-a');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);

    observeSessionActivityEvent('session-a', 'settled');
    expect(useSessionOrderingStore.getState().rankById.has('session-a')).toBe(false);
  });

  test('sorts each forest scope before flattening parent-first', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const childOlder = session('child-older', 5, 'root-older');
    const childNewer = session('child-newer', 6, 'root-older');

    const ordered = orderSessionsByLifecycleScopes(
      [rootNewer, childOlder, rootOlder, childNewer],
      new Set(),
      new Map([
        ['root-older', 100],
        ['child-older', 90],
      ]),
    );

    expect(ordered.map((item) => item.id)).toEqual([
      'root-older',
      'child-older',
      'child-newer',
      'root-newer',
    ]);
  });

  test('does not promote a root when only its child has lifecycle activity', () => {
    const rootOlder = session('root-older', 10);
    const rootNewer = session('root-newer', 20);
    const activeChild = session('active-child', 5, 'root-older');

    const ordered = orderSessionsByLifecycleScopes(
      [rootOlder, activeChild, rootNewer],
      new Set(),
      new Map([['active-child', 100]]),
    );

    expect(ordered.map((item) => item.id)).toEqual([
      'root-newer',
      'root-older',
      'active-child',
    ]);
  });

  test('authoritative snapshot raises frozen baselines without live ranks', () => {
    const older = session('older', 10);
    const newer = session('newer', 20);
    expect(compareSessionsByLifecycleOrder(older, newer, new Set(), new Map())).toBeGreaterThan(0);

    const liveBump = session('older', 30);
    expect(compareSessionsByLifecycleOrder(liveBump, newer, new Set(), new Map())).toBeGreaterThan(0);

    raiseSessionOrderingBaselines([liveBump, newer]);
    expect(compareSessionsByLifecycleOrder(liveBump, newer, new Set(), new Map())).toBeLessThan(0);
  });

  test('store-held live rank is not raised by an authoritative snapshot', () => {
    useSessionOrderingStore.setState({ rankById: new Map([['stale', 15]]) });
    raiseSessionOrderingBaselines([session('stale', 40)]);
    expect(useSessionOrderingStore.getState().rankById.get('stale')).toBe(15);
  });
});

describe('createSessionLifecycleComparator', () => {
  test('orders exactly like compareSessionsByLifecycleOrder, including pins, ranks, and item wrappers', () => {
    const withDirectory = (value: Session, directory: string): Session => ({ ...value, directory } as Session);
    const sessions = [
      withDirectory(session('a', 100), '/repo'),
      withDirectory(session('b', 300), '/repo'),
      withDirectory(session('c', 200), '/repo/'),
      withDirectory(session('d', 50, 'a'), '/repo'),
      withDirectory(session('e', 400), '/other'),
      withDirectory(session('f', 300), '/other'),
    ];
    const pinnedKey = JSON.stringify([getRuntimeKey(), '/repo', 'c']);
    const pinned = new Set([pinnedKey]);
    observeSessionActivityEvent('a', 'active');
    const ranks = useSessionOrderingStore.getState().rankById;

    const expected = [...sessions].sort((left, right) => compareSessionsByLifecycleOrder(left, right, pinned, ranks));
    expect(expected[0].id).toBe('c');
    expect([...sessions].sort(createSessionLifecycleComparator(pinned, ranks)).map((item) => item.id))
      .toEqual(expected.map((item) => item.id));

    const wrapped = sessions.map((item) => ({ session: item }));
    expect(wrapped.sort(createSessionLifecycleComparator(pinned, ranks, (entry: { session: Session }) => entry.session)).map((entry) => entry.session.id))
      .toEqual(expected.map((item) => item.id));
  });
});
