// Pending-review drafts: submit cleanup keeps summary, draft, and verdict per PR.
import { afterEach, describe, expect, test } from 'bun:test';
import { pendingReviewKey, useGitHubPendingReviewStore } from '@/stores/github/useGitHubPendingReviewStore';

const repo = 'github.com/octocat/hello-world';

afterEach(() => {
  useGitHubPendingReviewStore.getState().resetForRuntimeSwitch();
});

describe('useGitHubPendingReviewStore', () => {
  test('drafts survive submit cleanup keyed per PR', () => {
    const store = useGitHubPendingReviewStore.getState();
    store.addComment(repo, 7, { path: 'a.ts', body: 'nit' });
    store.setSummary(repo, 7, 'overall looks good');
    store.setCommentDraft(repo, 7, 'standalone remark');
    store.setVerdict(repo, 7, 'approve');
    // Clearing submitted line comments keeps the summary, draft, and verdict.
    store.clearComments(repo, 7);
    const entry = useGitHubPendingReviewStore.getState().entries[pendingReviewKey(repo, 7)];
    expect(entry?.comments).toHaveLength(0);
    expect(entry?.summary).toBe('overall looks good');
    expect(entry?.commentDraft).toBe('standalone remark');
    expect(entry?.verdict).toBe('approve');

    // Text revised while a submit was in flight is new work, not leftovers.
    store.setSummary(repo, 7, 'first version');
    store.setSummary(repo, 7, 'first version plus more');
    store.clearSummary(repo, 7, 'first version');
    expect(useGitHubPendingReviewStore.getState().entries[pendingReviewKey(repo, 7)]?.summary).toBe('first version plus more');
    store.clearSummary(repo, 7, 'first version plus more');
    expect(useGitHubPendingReviewStore.getState().entries[pendingReviewKey(repo, 7)]?.summary).toBe('');
  });
});
