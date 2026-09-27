import React from 'react';
import { formatGitHubRelativeTime } from './GitHubDetailScaffold';
import {
  GitHubEmptyState,
  GitHubIncompleteNotice,
  GitHubListFooter,
  GitHubListSkeleton,
  GitHubLoadMore,
  GitHubNumberJumpRow,
  GitHubRemoteSection,
  GitHubSearchInput,
  GitHubStaleBanner,
} from './GitHubListPrimitives';
import {
  GitHubFiltersMenu,
  GitHubRefreshButton,
  GitHubSortMenu,
} from './GitHubFiltersMenu';
import { GitHubUnavailableState, toUnavailableInfo } from './GitHubUnavailableState';
import type { IconName } from '@/components/icon/icons';

/**
 * Generic list view shared by the Pull requests and Issues lists (which are
 * ~70% identical: toolbar, stale banner, blocking error/first-load
 * branching, empty state, load more, remote section, incomplete notice,
 * footer). Entity specifics arrive as props: row rendering, toolbar menus,
 * and copy. The toolbar stays mounted through every list state so a filter
 * change never unmounts the search input mid-typing.
 */

export type ListRemoteView<TItem> = {
  items: TItem[];
  isSearching: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: { kind: string; message?: string; retryAt?: number | null } | null;
  onSearchAll: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

export type GitHubListViewProps<TItem extends { number: number }> = {
  /** Local view rows: the surface already applied state/involvement/text/sort. */
  items: TItem[];
  renderRow: (item: TItem) => React.ReactNode;
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  stale: boolean;
  error: { kind: string; message?: string } | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
  /** State/involvement (/labels) menus + sort + refresh + entity extras. */
  toolbarControls: React.ReactNode;
  /** True when no filter is active: empty state reads as "no items". */
  isDefaultFilters: boolean;
  /** Lowercase state label for the footer (`open`, `closed`, …). */
  stateLabel: string;
  kindSingular: string;
  kindPlural: string;
  noItemsTitle: string;
  noItemsBody?: string;
  noItemsIcon?: IconName;
  noItemsAction?: React.ReactNode;
  listAriaLabel: string;
  skeletonLabel: string;
  /** ISO timestamp per row for the footer's "updated …" suffix. */
  updatedAtOf: (item: TItem) => string | null | undefined;
  /** False while the viewed collections still page: counts show a `+` suffix. */
  countComplete?: boolean;
  /** Honesty notice for incomplete collections with an active filter. */
  incompleteNotice?: { summary: string; searching: boolean; onSearchAll: () => void } | null;
  /** Server search results below the local rows (deduped by the surface). */
  remote?: ListRemoteView<TItem> | null;
  /** `#123` / `123` query missing from loaded items: direct jump row. */
  numberJump?: number | null;
  numberJumpKind: string;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (number: number) => void;
};

export const GitHubListView = <TItem extends { number: number }>({
  items,
  renderRow,
  hasMore,
  isLoadingMore,
  isLoading,
  isRefreshing,
  stale,
  error,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  toolbarControls,
  isDefaultFilters,
  stateLabel,
  kindSingular,
  kindPlural,
  noItemsTitle,
  noItemsBody,
  noItemsIcon,
  noItemsAction,
  listAriaLabel,
  skeletonLabel,
  updatedAtOf,
  countComplete = true,
  incompleteNotice = null,
  remote = null,
  numberJump = null,
  numberJumpKind,
  onClearFilters,
  onLoadMore,
  onRetry,
  onOpen,
}: GitHubListViewProps<TItem>): React.ReactElement => {
  const footerSummary = React.useMemo(() => {
    if (items.length === 0) return null;
    const count = items.length === 1 && countComplete
      ? `1 ${kindSingular}`
      : `${items.length}${countComplete ? '' : '+'} ${kindPlural}`;
    let latest = 0;
    for (const item of items) {
      const parsed = updatedAtOf(item) ? Date.parse(updatedAtOf(item) as string) : NaN;
      if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
    }
    const updated = latest > 0 ? formatGitHubRelativeTime(new Date(latest).toISOString()) : '';
    return `${count} · ${stateLabel.toLowerCase()}${updated ? ` · updated ${updated}` : ''}`;
  }, [items, stateLabel, kindSingular, kindPlural, countComplete, updatedAtOf]);

  const blockingError = Boolean(error) && items.length === 0;
  const firstLoad = !blockingError && isLoading && items.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stale ? <GitHubStaleBanner onRetry={onRetry} /> : null}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <GitHubSearchInput
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          ariaLabel={searchAriaLabel}
        />
        {toolbarControls}
        <GitHubRefreshButton isRefreshing={isRefreshing || isLoading} onRefresh={onRetry} />
      </div>
      {blockingError ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitHubUnavailableState
            info={toUnavailableInfo(error as never)}
            onRetry={onRetry}
            isRetrying={isLoading}
          />
        </div>
      ) : firstLoad ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <GitHubListSkeleton label={skeletonLabel} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label={listAriaLabel}>
          {items.length === 0 && numberJump == null ? (
            <GitHubEmptyState
              kind={isDefaultFilters ? 'no-items' : 'no-match'}
              noItemsTitle={noItemsTitle}
              noItemsBody={isDefaultFilters ? noItemsBody : undefined}
              noItemsIcon={noItemsIcon}
              noItemsAction={isDefaultFilters ? noItemsAction : undefined}
              onClearFilters={isDefaultFilters ? undefined : onClearFilters}
            />
          ) : (
            <>
              {items.length > 0 ? (
                <ul className="flex flex-col p-1.5">
                  {items.map((item) => (
                    <React.Fragment key={item.number}>{renderRow(item)}</React.Fragment>
                  ))}
                </ul>
              ) : null}
              {numberJump != null ? (
                <GitHubNumberJumpRow number={numberJump} kindLabel={numberJumpKind} onOpen={() => onOpen(numberJump)} />
              ) : null}
            </>
          )}
          <GitHubLoadMore hasMore={hasMore} isLoading={isLoadingMore || isLoading} onLoadMore={onLoadMore} />
          {remote && (remote.isSearching || remote.error || remote.items.length > 0) ? (
            <GitHubRemoteSection
              title="More results from GitHub"
              isSearching={remote.isSearching}
              error={remote.error}
              hasResults={remote.items.length > 0}
              hasMore={remote.hasMore}
              isLoadingMore={remote.isLoadingMore}
              onRetry={remote.onRetry}
              onLoadMore={remote.onLoadMore}
            >
              <ul className="flex flex-col">
                {remote.items.map((item) => (
                  <React.Fragment key={item.number}>{renderRow(item)}</React.Fragment>
                ))}
              </ul>
            </GitHubRemoteSection>
          ) : null}
        </div>
      )}
      {!blockingError && !firstLoad && incompleteNotice ? (
        <GitHubIncompleteNotice
          matchSummary={incompleteNotice.summary}
          searching={incompleteNotice.searching}
          onSearchAll={incompleteNotice.onSearchAll}
        />
      ) : null}
      {!blockingError && !firstLoad && footerSummary ? <GitHubListFooter summary={footerSummary} /> : null}
    </div>
  );
};

/** Row toolbar for entity filter/sort menus (the refresh button lives in the view). */
export const GitHubListMenus: React.FC<{
  stateValue: string;
  stateOptions: Array<{ id: string; label: string }>;
  onStateChange: (id: string) => void;
  involvementValue: string;
  involvementOptions: Array<{ id: string; label: string }>;
  onInvolvementChange: (id: string) => void;
  labelsValue?: string;
  onLabelsChange?: (value: string) => void;
  sortValue: string;
  sortOptions: Array<{ id: string; label: string }>;
  onSortChange: (id: string) => void;
  sortAriaLabel: string;
}> = ({
  stateValue,
  stateOptions,
  onStateChange,
  involvementValue,
  involvementOptions,
  onInvolvementChange,
  labelsValue,
  onLabelsChange,
  sortValue,
  sortOptions,
  onSortChange,
  sortAriaLabel,
}) => (
  <>
    <GitHubFiltersMenu
      stateValue={stateValue}
      stateOptions={stateOptions}
      onStateChange={onStateChange}
      involvementValue={involvementValue}
      involvementOptions={involvementOptions}
      onInvolvementChange={onInvolvementChange}
      labelsValue={labelsValue}
      onLabelsChange={onLabelsChange}
    />
    <GitHubSortMenu
      value={sortValue}
      options={sortOptions}
      onChange={onSortChange}
      ariaLabel={sortAriaLabel}
    />
  </>
);
