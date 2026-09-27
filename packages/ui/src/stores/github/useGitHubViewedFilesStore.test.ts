// Viewed files: marks keyed per head SHA, cleared on new SHA, capped to recent heads.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_VIEWED_FILE_HEADS,
  useGitHubViewedFilesStore,
  viewedFilesKey,
} from '@/stores/github/useGitHubViewedFilesStore';

beforeEach(() => {
  useGitHubViewedFilesStore.setState({ entries: {} });
});

describe('useGitHubViewedFilesStore', () => {
  test('marks are keyed per head SHA and capped to recent heads', () => {
    const store = useGitHubViewedFilesStore.getState();
    store.syncHeadSha('h/o/r', 1, 'sha-1');
    store.setViewed('h/o/r', 1, 'src/a.ts', true);
    store.setViewed('h/o/r', 1, 'src/b.ts', true);
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 1)]?.viewed).toEqual(['src/a.ts', 'src/b.ts']);
    store.setViewed('h/o/r', 1, 'src/a.ts', false);
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 1)]?.viewed).toEqual(['src/b.ts']);
    store.syncHeadSha('h/o/r', 2, 'sha-9');
    store.setViewed('h/o/r', 2, 'src/z.ts', true);

    // A new head SHA clears that PR's marks without touching other PRs.
    store.syncHeadSha('h/o/r', 1, 'sha-2');
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 1)]?.viewed).toEqual([]);
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 2)]?.viewed).toEqual(['src/z.ts']);
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 2)]?.headSha).toBe('sha-9');

    // The same SHA is a no-op; filling past the cap evicts the oldest heads first.
    const before = useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 2)]?.viewed;
    store.syncHeadSha('h/o/r', 2, 'sha-9');
    expect(useGitHubViewedFilesStore.getState().entries[viewedFilesKey('h/o/r', 2)]?.viewed).toBe(before);
    for (let number = 3; number <= MAX_VIEWED_FILE_HEADS + 5; number += 1) {
      store.syncHeadSha('h/o/r', number, `sha-${number}`);
      store.setViewed('h/o/r', number, 'src/a.ts', true);
    }
    const entries = useGitHubViewedFilesStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(MAX_VIEWED_FILE_HEADS);
    expect(entries[viewedFilesKey('h/o/r', MAX_VIEWED_FILE_HEADS + 5)]?.viewed).toEqual(['src/a.ts']);
  });
});
