import React from 'react';
import { excludeNumbers, parseNumberQuery } from './githubListFiltering';
import type { ListRemoteView } from './GitHubListView';

type RemoteEntry<TItem> = {
  data: { items: TItem[]; nextCursor: string | null } | null;
  isLoading: boolean;
  error: { kind: string; message?: string; retryAt?: number | null } | null;
} | null;

/**
 * Remote-search machinery shared by the Pull requests and Issues surfaces.
 * The wide collections never download everything, so an active filter with
 * no local hits (or an involvement the local view cannot prove, like an
 * unknown viewer) falls back to a debounced server search rendered below the
 * local rows. Callers compute only what differs: the query and when to auto-run.
 */
export const useGitHubRemoteSearch = <TItem extends { number: number }, TRemoteQuery>(options: {
  repo: string;
  /** Distinct-query entry the surface subscribes to (per-key, never cross-repo). */
  query: TRemoteQuery;
  /** Stable string for the query (resets manual state per query). */
  queryKey: string;
  /** True when the local view cannot answer and the server should be asked. */
  autoRemote: boolean;
  /** Numbers already shown locally (remote hits dedupe against these). */
  indexNumbers: Set<number>;
  /** Rows currently shown; `#123` offers a direct jump unless it is one of them. */
  visibleItems: readonly TItem[];
  /** Raw search text for the `#123` direct-jump row. */
  searchText: string;
  useRemoteEntry: (repo: string | null, query: TRemoteQuery) => RemoteEntry<TItem>;
  runSearch: (query: TRemoteQuery) => Promise<unknown>;
  runLoadMore: (query: TRemoteQuery) => Promise<unknown>;
}): {
  remoteView: ListRemoteView<TItem> | null;
  numberJump: number | null;
  remotePending: boolean;
  handleSearchAll: () => void;
} => {
  const { repo, query, queryKey, autoRemote, indexNumbers, visibleItems, searchText, useRemoteEntry, runSearch, runLoadMore } = options;
  const [remotePending, setRemotePending] = React.useState(false);
  // Manual "Search all on GitHub" for the query it was pressed on. Reset
  // when the repo changes; a new query re-evaluates the auto condition.
  const [manualRemoteKey, setManualRemoteKey] = React.useState<string | null>(null);
  React.useEffect(() => setManualRemoteKey(null), [repo]);

  const remoteEntry = useRemoteEntry(repo, query);
  const showRemote = autoRemote || manualRemoteKey === queryKey || remoteEntry != null;

  const runRemoteSearch = React.useCallback(() => {
    setRemotePending(true);
    void runSearch(query)
      .catch(() => null)
      .finally(() => setRemotePending(false));
  }, [query, runSearch]);

  React.useEffect(() => {
    if (!autoRemote) return;
    if (remoteEntry?.data || remoteEntry?.isLoading || remotePending) return;
    const timer = setTimeout(runRemoteSearch, 400);
    return () => clearTimeout(timer);
  }, [autoRemote, queryKey, remoteEntry?.data, remoteEntry?.isLoading, remotePending, runRemoteSearch]);

  const handleSearchAll = React.useCallback(() => {
    setManualRemoteKey(queryKey);
    runRemoteSearch();
  }, [queryKey, runRemoteSearch]);

  const handleLoadMoreRemote = React.useCallback(() => {
    setRemotePending(true);
    void runLoadMore(query)
      .catch(() => null)
      .finally(() => setRemotePending(false));
  }, [query, runLoadMore]);

  const remoteItems = React.useMemo(
    () => excludeNumbers(remoteEntry?.data?.items ?? [], indexNumbers),
    [remoteEntry?.data?.items, indexNumbers],
  );

  const numberQuery = parseNumberQuery(searchText);
  // Jump even when the number is loaded but hidden by the state filter
  // (e.g. `#150` while viewing Open), not only when it was never downloaded.
  const numberJump = numberQuery != null && !visibleItems.some((item) => item.number === numberQuery) ? numberQuery : null;

  const remoteView = React.useMemo(
    () =>
      showRemote
        ? {
            items: remoteItems,
            isSearching: remotePending || (remoteEntry?.isLoading ?? false),
            isLoadingMore: remotePending,
            hasMore: remoteEntry?.data?.nextCursor != null,
            error: remoteEntry?.error ?? null,
            onSearchAll: handleSearchAll,
            onLoadMore: handleLoadMoreRemote,
            onRetry: runRemoteSearch,
          }
        : null,
    [
      showRemote,
      remoteItems,
      remotePending,
      remoteEntry?.isLoading,
      remoteEntry?.data?.nextCursor,
      remoteEntry?.error,
      handleSearchAll,
      handleLoadMoreRemote,
      runRemoteSearch,
    ],
  );

  return { remoteView, numberJump, remotePending, handleSearchAll };
};
