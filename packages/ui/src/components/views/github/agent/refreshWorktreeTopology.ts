import type { GitAPI } from '@/lib/api/types';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';

/**
 * Re-list the worktrees of the project that owns `directory` right after a
 * GitHub flow created or switched one, mirroring the normal new-worktree flow
 * (`useWorktreeCreationStore` awaits `refreshProject` after setup). Without
 * it the sidebar only learns about the new worktree on the next background
 * discovery pass (focus/visibility/60 s interval).
 *
 * `directory` may be the project root, a subdirectory, or a linked worktree;
 * the owning registered project is resolved first. Best-effort: a failed
 * refresh leaves the background discovery to catch up.
 */
export const refreshWorktreeTopology = async (directory: string, git: GitAPI | null | undefined): Promise<void> => {
  if (!git?.listGitWorktrees) return;
  const projects = useProjectsStore.getState().projects;
  const worktrees = buildAvailableWorktreesByProject(projects, useWorktreeStore.getState());
  const project = resolveProjectForSessionDirectory(projects, worktrees, directory);
  const projectRoot = project?.path ?? directory;
  try {
    // Forced: this follows an explicit mutation (create/switch/remove), so
    // the background freshness window must not absorb it.
    await useWorktreeStore.getState().refreshProject(projectRoot, git, { force: true });
  } catch {
    // Background worktree discovery still reconciles on its next pass.
  }
};
