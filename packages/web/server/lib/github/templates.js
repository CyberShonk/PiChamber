/** Issue-template listing (markdown only; YAML forms skipped). See DOCUMENTATION.md. */

import { createTtlCache, readWithStaleFallback, repoCachePrefix, repoInvalidatePredicate } from './cache.js';

export const TEMPLATES_TTL_MS = 5 * 60_000;
const MAX_TEMPLATES = 20;
const READ_CONCURRENCY = 4;
const MAX_TEMPLATE_CHARS = 20_000;
const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
const LEGACY_TEMPLATE_FILES = ['.github/ISSUE_TEMPLATE.md', '.github/issue_template.md'];

const isMarkdownTemplate = (name) => typeof name === 'string' && name.toLowerCase().endsWith('.md');

/** Strip a leading YAML front-matter block (`---` … `---`) so template
 * metadata never lands in a new issue body. Returns the body unchanged when
 * no front matter is present. */
export const stripTemplateFrontMatter = (text) => {
  if (typeof text !== 'string') return '';
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  const after = text.slice(end + 4);
  return after.replace(/^\r?\n/, '');
};

/** Template display name: front-matter `name:` when present, else the
 * filename without `.md` (dashes/underscores become spaces). */
export const templateDisplayName = (filename, body) => {
  const base = String(filename || 'template').replace(/\.md$/i, '');
  const match = typeof body === 'string' && body.startsWith('---')
    ? body.slice(0, 2000).match(/^name\s*:\s*(.+?)\s*$/m)
    : null;
  const frontName = match ? String(match[1]).replace(/^['"]|['"]$/g, '').trim() : '';
  if (frontName) return frontName;
  return base.replace(/[-_]+/g, ' ').trim() || base;
};

const decodeBase64Content = (entry) => {
  if (typeof entry?.content !== 'string' || entry.encoding !== 'base64') return null;
  try {
    return Buffer.from(entry.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
};

const truncateBody = (body) => {
  if (body.length <= MAX_TEMPLATE_CHARS) return { body, truncated: false };
  return {
    body: `${body.slice(0, MAX_TEMPLATE_CHARS)}…[truncated ${body.length - MAX_TEMPLATE_CHARS} chars]`,
    truncated: true,
  };
};

const isNoAccess = (error) => error?.kind === 'unavailable' && error?.reason === 'no-access';

export const createTemplatesService = ({ client, now = Date.now } = {}) => {
  if (!client || typeof client.request !== 'function') {
    throw new Error('createTemplatesService requires client');
  }
  const cache = createTtlCache({ ttlMs: TEMPLATES_TTL_MS, maxEntries: 200, now });

  const repoKey = (credential, repo) => repoCachePrefix(credential, repo);

  const readContents = (credential, repo, path) => client.request({
    credential,
    host: repo.host,
    method: 'GET',
    path: `/repos/${repo.owner}/${repo.repo}/contents/${path}`,
    operation: 'issue templates',
  });

  const listIssueTemplates = async (credential, repo) => {
    const key = `${repoKey(credential, repo)}:templates`;
    const load = async () => {
      let dirEntries = null;
      try {
        const response = await readContents(credential, repo, TEMPLATE_DIR);
        if (Array.isArray(response.body)) dirEntries = response.body;
      } catch (error) {
        if (!isNoAccess(error)) throw error;
        // Missing directory or unreadable repo — distinguish below.
        dirEntries = null;
      }

      let candidates = [];
      if (dirEntries) {
        candidates = dirEntries
          .filter((entry) => entry?.type === 'file' && isMarkdownTemplate(entry.name) && typeof entry.path === 'string')
          .map((entry) => ({ filename: entry.name, path: entry.path }));
      } else {
        // Template directory absent: probe the legacy single files. A real
        // access failure surfaces here as no-access instead of empty.
        for (const legacy of LEGACY_TEMPLATE_FILES) {
          try {
            const response = await readContents(credential, repo, legacy);
            if (response.body?.type === 'file') {
              candidates.push({ filename: legacy.split('/').pop(), path: legacy });
              break;
            }
          } catch (error) {
            if (!isNoAccess(error)) throw error;
          }
        }
        if (candidates.length === 0) {
          // Contents reads report no-access for both "missing" and "forbidden".
          // One repo lookup tells them apart: readable repo → no templates.
          await client.request({
            credential,
            host: repo.host,
            method: 'GET',
            path: `/repos/${repo.owner}/${repo.repo}`,
            operation: 'issue templates',
          });
          return { templates: [] };
        }
      }

      const bounded = candidates.slice(0, MAX_TEMPLATES);
      // Candidate file reads run with a small concurrency cap; results keep
      // candidate priority order via indexed writes. One unreadable template
      // must not erase the readable ones.
      const slots = new Array(bounded.length).fill(null);
      const readCandidate = async (candidate, index) => {
        try {
          const response = await readContents(credential, repo, candidate.path);
          const raw = decodeBase64Content(response.body) ?? '';
          const { body, truncated } = truncateBody(stripTemplateFrontMatter(raw));
          slots[index] = {
            filename: candidate.filename,
            name: templateDisplayName(candidate.filename, raw),
            body,
            truncated,
          };
        } catch {
          slots[index] = null;
        }
      };
      for (let start = 0; start < bounded.length; start += READ_CONCURRENCY) {
        await Promise.all(bounded.slice(start, start + READ_CONCURRENCY).map((candidate, offset) => readCandidate(candidate, start + offset)));
      }
      return { templates: slots.filter((slot) => slot !== null), ...(candidates.length > bounded.length ? { truncated: true } : {}) };
    };
    const { value, fetchedAt, stale } = await readWithStaleFallback(cache, key, load);
    return { repo: { ...repo }, ...value, fetchedAt, ...(stale ? { stale: true } : {}) };
  };

  const invalidate = (credential = null, repo = null) => {
    cache.invalidate(repoInvalidatePredicate({ fingerprint: credential?.fingerprint || '', repo }));
  };

  return { listIssueTemplates, invalidate };
};
