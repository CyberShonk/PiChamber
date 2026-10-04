import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import { useGitHubPullRequestsStore } from '@/stores/useGitHubPullRequestsStore';

// Kept apart from PullRequestsSurface so the sidebar, Git view and issue
// detail can hand off a PR selection without statically importing the
// surface, whose diff review stack (@pierre/diffs → Shiki) would otherwise
// join the eager startup graph.
export const openPullRequestInSurface = (directory: string, repo: string, number: number): void => {
  // Selection handoff for the Git chip / sidebar badges: persist which PR the
  // Pull requests surface should show, then open the surface. The surface
  // reads this selection on mount.
  useGitHubPullRequestsStore.getState().selectPullRequest(directory, repo, number);
  const dirKey = normalizeDirectoryPathKey(directory);
  void import('@/stores/useUIStore').then(({ useUIStore }) => {
    useUIStore.getState().openContextSurface(dirKey, 'pull-requests');
  }).catch(() => {});
  void import('@/stores/useGitHubScopeStore').then(({ useGitHubScopeStore }) => {
    useGitHubScopeStore.getState().setSelectedRepo(directory, repo);
  }).catch(() => {});
};
