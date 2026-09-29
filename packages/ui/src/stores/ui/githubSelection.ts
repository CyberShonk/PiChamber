import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';

/**
 * Persisted per-directory GitHub repository selection.
 *
 * Stored inside `useUIStore` alongside `contextPanelByDirectory` so it rides
 * the existing per-directory UI persistence (deferred safe storage, version
 * migration sanitization, root clamping) and survives reload. Keys are
 * normalized directory paths; values are `host/owner/repo` refs.
 */

export const GITHUB_SELECTION_MAX_ROOTS = 50;

export const normalizeGitHubRepoRef = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 3) return null;
  const [host, owner, repo] = parts.map((part) => part.trim());
  if (!host || !owner || !repo) return null;
  if (owner.length > 100 || repo.length > 100 || host.length > 253) return null;
  return `${host}/${owner}/${repo}`;
};

export const sanitizeGitHubSelectionByDirectory = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const next: Record<string, string> = {};
  for (const [rawDirectory, rawRef] of Object.entries(source)) {
    const directory = normalizeDirectoryPathKey(rawDirectory);
    const ref = normalizeGitHubRepoRef(rawRef);
    if (!directory || !ref) continue;
    next[directory] = ref;
  }
  return next;
};

export const clampGitHubSelectionRoots = (
  byDirectory: Record<string, string>,
  maxRoots: number,
): Record<string, string> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) return byDirectory;
  // Keep insertion order tail (most recently written last). Callers always
  // rewrite the touched directory last, so the slice preserves fresh picks.
  const next: Record<string, string> = {};
  for (const [directory, ref] of entries.slice(-maxRoots)) {
    next[directory] = ref;
  }
  return next;
};
