import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { GitHubIssueSummary } from '@/lib/api/types';
import {
  GitHubStateGlyph,
} from '../GitHubDetailScaffold';
import {
  GitHubListMenus,
  GitHubListView,
  type ListRemoteView,
} from '../GitHubListView';
import {
  GitHubRow,
  GitHubRowAuthor,
  GitHubRowLabels,
} from '../GitHubRow';
import type { IssuesFilters } from '@/stores/useGitHubIssuesStore';
import { ISSUE_INVOLVEMENT_TABS, ISSUE_SORT_OPTIONS, ISSUE_STATE_TABS } from './issueLogic';

const commentCountSignal = (count?: number): React.ReactNode => {
  if (typeof count !== 'number' || count === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 typography-micro tabular-nums text-muted-foreground"
      title={`${count} comments`}
      aria-label={`${count} comments`}
    >
      <Icon name="chat-1" className="size-3.5" />
      {count}
    </span>
  );
};

export type IssuesRemoteSection = ListRemoteView<GitHubIssueSummary>;

export const IssuesList: React.FC<{
  /** Local view rows: the surface already applied state/involvement/labels/text/sort over the collections. */
  items: GitHubIssueSummary[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  stale: boolean;
  error: { kind: string; message?: string } | null;
  filters: IssuesFilters;
  /** False while the viewed collections still page: counts show a `+` suffix. */
  countComplete?: boolean;
  /** Honesty notice for incomplete collections with an active filter. */
  incompleteNotice?: { summary: string; searching: boolean; onSearchAll: () => void } | null;
  /** Server search results below the local rows (deduped by the surface). */
  remote?: IssuesRemoteSection | null;
  /** `#123` / `123` query missing from loaded items: direct jump row. */
  numberJump?: number | null;
  onFiltersChange: (patch: Partial<IssuesFilters>) => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (number: number) => void;
  onNewIssue: () => void;
}> = ({
  items,
  hasMore,
  isLoadingMore,
  isLoading,
  isRefreshing,
  stale,
  error,
  filters,
  countComplete = true,
  incompleteNotice = null,
  remote = null,
  numberJump = null,
  onFiltersChange,
  onClearFilters,
  onLoadMore,
  onRetry,
  onOpen,
  onNewIssue,
}) => {
  const isDefaultFilters =
    filters.state === 'open' && filters.involvement === 'all' && !filters.search.trim() && !filters.labels.trim();

  const renderRow = React.useCallback((issue: GitHubIssueSummary) => (
    <li key={issue.number} role="listitem">
      <GitHubRow
        glyph={<GitHubStateGlyph kind="issue" state={issue.state} />}
        number={`#${issue.number}`}
        title={issue.title}
        signals={commentCountSignal(issue.comments)}
        meta={
          <>
            <GitHubRowAuthor login={issue.author?.login} avatarUrl={issue.author?.avatarUrl} />
            <GitHubRowLabels labels={issue.labels ?? []} />
          </>
        }
        updatedAt={issue.updatedAt}
        onOpen={() => onOpen(issue.number)}
        ariaLabel={`Open issue #${issue.number} ${issue.title}`}
      />
    </li>
  ), [onOpen]);

  return (
    <GitHubListView
      items={items}
      renderRow={renderRow}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      stale={stale}
      error={error}
      searchValue={filters.search}
      onSearchChange={(value) => onFiltersChange({ search: value })}
      searchPlaceholder="Search issues, or label:bug"
      searchAriaLabel="Search issues"
      toolbarControls={
        <>
          <GitHubListMenus
            stateValue={filters.state}
            stateOptions={ISSUE_STATE_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
            onStateChange={(id) => onFiltersChange({ state: id as IssuesFilters['state'] })}
            involvementValue={filters.involvement}
            involvementOptions={ISSUE_INVOLVEMENT_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
            onInvolvementChange={(id) => onFiltersChange({ involvement: id as IssuesFilters['involvement'] })}
            labelsValue={filters.labels}
            onLabelsChange={(value) => onFiltersChange({ labels: value })}
            sortValue={filters.sort}
            sortOptions={ISSUE_SORT_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
            onSortChange={(id) => onFiltersChange({ sort: id as IssuesFilters['sort'] })}
            sortAriaLabel="Sort issues"
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onNewIssue}
            aria-label="New issue"
            title="New issue"
          >
            <Icon name="add" className="size-3.5" />
            New issue
          </Button>
        </>
      }
      isDefaultFilters={isDefaultFilters}
      stateLabel={ISSUE_STATE_TABS.find((tab) => tab.id === filters.state)?.label ?? filters.state}
      kindSingular="issue"
      kindPlural="issues"
      noItemsTitle={filters.state === 'open' ? 'No open issues' : 'No issues yet'}
      noItemsBody="Issues for this repository appear here."
      noItemsIcon="inbox-archive"
      noItemsAction={
        <Button type="button" variant="outline" size="sm" onClick={onNewIssue}>
          <Icon name="add" className="size-3.5" />
          New issue
        </Button>
      }
      listAriaLabel="Issues"
      skeletonLabel="Loading issues"
      updatedAtOf={(issue) => issue.updatedAt}
      countComplete={countComplete}
      incompleteNotice={incompleteNotice}
      remote={remote}
      numberJump={numberJump}
      numberJumpKind="issue"
      onClearFilters={onClearFilters}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onOpen={onOpen}
    />
  );
};
