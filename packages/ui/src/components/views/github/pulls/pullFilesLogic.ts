import type { IconName } from '@/components/icon/icons';
import type { GitHubPullRequestFile } from '@/lib/api/types';

/**
 * Pure helpers for the PR "Code" tab (file grouping, status mapping,
 * collapse defaults, totals).
 */

/** Files changing more than this many lines start collapsed behind a loader. */
export const LARGE_FILE_CHANGED_LINES = 800;

/** How many leading small files start expanded. */
export const DEFAULT_EXPANDED_FILES = 3;

export type FileStatusKind = 'added' | 'removed' | 'modified' | 'renamed' | 'other';

/** Single status meta table: kind → icon, jump-list letter, semantic tint. */
const FILE_STATUS_META: Record<FileStatusKind, { icon: IconName; letter: string; tint: string }> = {
  added: { icon: 'add-circle', letter: 'A', tint: 'text-[var(--status-success)]' },
  removed: { icon: 'subtract', letter: 'D', tint: 'text-[var(--status-error)]' },
  modified: { icon: 'pencil', letter: 'M', tint: 'text-[var(--status-warning)]' },
  renamed: { icon: 'expand-up-down', letter: 'R', tint: 'text-[var(--status-info)]' },
  other: { icon: 'file', letter: '•', tint: 'text-muted-foreground' },
};

/** Map GitHub's file `status` string onto a stable display kind. */
export const statusKindForFile = (status: string | null | undefined): FileStatusKind => {
  switch ((status ?? '').toLowerCase()) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'modified':
      return 'modified';
    case 'renamed':
      return 'renamed';
    default:
      return 'other';
  }
};

/** Status icon per kind; names must exist in the generated sprite. */
export const statusIconForFile = (kind: FileStatusKind): IconName => FILE_STATUS_META[kind].icon;

/** Single-letter badge per kind for the jump list. */
export const statusLetterForFile = (kind: FileStatusKind): string => FILE_STATUS_META[kind].letter;

/** Status tint using semantic tokens only. */
export const statusTintForFile = (kind: FileStatusKind): string => FILE_STATUS_META[kind].tint;

/** Split `dir/base.ext` into a muted directory and an emphasized basename. */
export const splitFilePath = (filename: string): { dir: string; base: string } => {
  const slash = filename.lastIndexOf('/');
  if (slash < 0) return { dir: '', base: filename };
  return { dir: filename.slice(0, slash), base: filename.slice(slash + 1) };
};

/** Total changed lines for collapse/large-file decisions. */
export const changedLinesForFile = (file: Pick<GitHubPullRequestFile, 'additions' | 'deletions' | 'changes'>): number => {
  const additions = typeof file.additions === 'number' ? file.additions : 0;
  const deletions = typeof file.deletions === 'number' ? file.deletions : 0;
  if (additions !== 0 || deletions !== 0) return additions + deletions;
  return typeof file.changes === 'number' ? file.changes : 0;
};

export const isLargeFile = (file: Pick<GitHubPullRequestFile, 'additions' | 'deletions' | 'changes'>): boolean =>
  changedLinesForFile(file) > LARGE_FILE_CHANGED_LINES;

export type FileFolderGroup = {
  /** Folder path, or '' for repository-root files. */
  folder: string;
  files: GitHubPullRequestFile[];
};

/**
 * Group files by their containing folder, folders first (root files last
 * under ''), files alphabetical within each group.
 */
export const groupFilesByFolder = (files: readonly GitHubPullRequestFile[]): FileFolderGroup[] => {
  const buckets = new Map<string, GitHubPullRequestFile[]>();
  for (const file of files) {
    const slash = file.filename.lastIndexOf('/');
    const folder = slash < 0 ? '' : file.filename.slice(0, slash);
    const bucket = buckets.get(folder);
    if (bucket) bucket.push(file);
    else buckets.set(folder, [file]);
  }
  const groups: FileFolderGroup[] = [...buckets.entries()].map(([folder, entries]) => ({
    folder,
    files: [...entries].sort((a, b) =>
      a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }),
    ),
  }));
  groups.sort((a, b) => {
    if (a.folder === '') return 1;
    if (b.folder === '') return -1;
    return a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' });
  });
  return groups;
};

export const fileTotals = (files: readonly Pick<GitHubPullRequestFile, 'additions' | 'deletions'>[]): {
  additions: number;
  deletions: number;
} => {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += typeof file.additions === 'number' ? file.additions : 0;
    deletions += typeof file.deletions === 'number' ? file.deletions : 0;
  }
  return { additions, deletions };
};

/**
 * Default collapsed map: the first `DEFAULT_EXPANDED_FILES` small files
 * start expanded, everything else (and every large file) starts collapsed.
 */export const defaultCollapsedForFiles = (files: readonly GitHubPullRequestFile[]): Record<string, boolean> => {
  const collapsed: Record<string, boolean> = {};
  files.forEach((file, index) => {
    collapsed[file.filename] = index >= DEFAULT_EXPANDED_FILES || isLargeFile(file);
  });
  return collapsed;
};

/**
 * Blob URL for "Open on GitHub" fallbacks. `repo` is the canonical
 * `host/owner/name` string; without a head SHA the PR files page is the
 * only stable target, so this returns null.
 */
export const githubBlobUrlForFile = (
  repo: string,
  headSha: string | null | undefined,
  filename: string,
): string | null => {
  if (!headSha) return null;
  const parts = repo.split('/');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  const [host, owner, name] = parts;
  return `https://${host}/${owner}/${name}/blob/${headSha}/${filename}`;
};
