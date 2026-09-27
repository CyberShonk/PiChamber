/* eslint-disable react-refresh/only-export-components -- sanitizer helpers colocated with their component by design */
import React from 'react';
import DOMPurify from 'dompurify';
import { openExternalUrl } from '@/lib/url';

/**
 * Rich-body rendering for GitHub PR/issue descriptions and comments.
 *
 * GitHub's `bodyHTML` is already server-sanitized; we sanitize again
 * client-side with DOMPurify. Sanitization is memoized by HTML string, so
 * long comment lists pay it once per distinct body.
 */

/** Tags GitHub emits for rendered markdown (prose, media, tables, code, task lists). */
const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'kbd', 'li',
  'ol', 'p', 'picture', 'pre', 's', 'source', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video',
];

/** `img` keeps its GitHub layout attrs; `input` only task-list state; no `style`, no event handlers. */
const ALLOWED_ATTR = [
  'abbr', 'align', 'alt', 'checked', 'colspan', 'controls', 'disabled', 'height',
  'href', 'lang', 'open', 'rel', 'rowspan', 'sizes', 'src', 'srcset', 'target',
  'title', 'type', 'width',
];

const GITHUB_SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'link', 'meta', 'base', 'frame', 'frameset'],
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
};

/**
 * Convert raw inline `<img ...>` tags in markdown into `![alt](src)` image
 * syntax, so the markdown fallback never prints literal tags (optimistic or
 * unrendered comments). Non-img HTML passes through untouched.
 */
export const preprocessMarkdownImages = (markdown: string): string => {
  if (!markdown || !markdown.includes('<img')) return markdown;
  return markdown.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    if (!srcMatch) return '';
    const src = srcMatch[1].replace(/^['"]|['"]$/g, '').trim();
    if (!src || /^(javascript|vbscript|data):/i.test(src)) return '';
    const altMatch = tag.match(/\balt\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    const alt = (altMatch ? altMatch[1].replace(/^['"]|['"]$/g, '') : '').replace(/\[|\]/g, '');
    return `![${alt}](${src})`;
  });
};

const stripTagWithContents = (html: string, tag: string): string => {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>|<${tag}\\b[^>]*\\/?>`, 'gi');
  let previous = '';
  let current = html;
  while (previous !== current) {
    previous = current;
    current = current.replace(pattern, '');
  }
  return current;
};

const UNSAFE_URL_PATTERN = /^\s*(javascript|vbscript|data|file|blob):/i;

/**
 * String-only fallback sanitizer for environments without DOM (SSR, tests):
 * DOMPurify needs `window`, so server-side renders must never emit raw
 * `bodyHTML`. Mirrors the DOMPurify config above closely enough that the
 * security tests hold on both paths.
 */
export const fallbackSanitizeGitHubHtml = (html: string): string => {
  if (!html) return '';
  let out = String(html);
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'link', 'meta', 'base']) {
    out = stripTagWithContents(out, tag);
  }
  const allowedTags = new Set(ALLOWED_TAGS);
  const allowedAttrs = new Set(ALLOWED_ATTR.map((attr) => attr.toLowerCase()));
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?\/?>/g, (full, rawTag: string, rawAttrs: string | undefined) => {
    const tag = String(rawTag).toLowerCase();
    const closing = full.startsWith('</');
    if (!allowedTags.has(tag)) return '';
    if (closing) return `</${tag}>`;
    // Task-list checkboxes only: any other input (or non-checkbox type) is dropped.
    if (tag === 'input') {
      const typeMatch = (rawAttrs || '').match(/\btype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
      const type = typeMatch ? typeMatch[1].replace(/^['"]|['"]$/g, '').toLowerCase() : '';
      if (type !== 'checkbox') return '';
    }
    const kept: string[] = [];
    const attrPattern = /([a-zA-Z-:]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(rawAttrs || '')) !== null) {
      const name = match[1].toLowerCase();
      if (name.startsWith('on') || name === 'style' || !allowedAttrs.has(name)) continue;
      let value = match[2] ?? null;
      if (value != null) {
        value = value.replace(/^['"]|['"]$/g, '');
        if ((name === 'href' || name === 'src' || name === 'srcset') && UNSAFE_URL_PATTERN.test(value.trim())) continue;
        kept.push(`${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`);
      } else if (name === 'checked' || name === 'disabled' || name === 'open' || name === 'controls') {
        kept.push(name);
      }
    }
    const selfClose = full.endsWith('/>') ? ' /' : '';
    return `<${tag}${kept.length > 0 ? ` ${kept.join(' ')}` : ''}${selfClose}>`;
  });
  return out;
};

/** String-safe enrichment shared by both sanitize paths (no DOM needed). */
const enrichSanitizedHtml = (html: string): string => {
  if (!html) return '';
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      let out = tag;
      if (!/\bloading\s*=/i.test(out)) out = out.replace(/<img/i, '<img loading="lazy"');
      if (!/\bdecoding\s*=/i.test(out)) out = out.replace(/<img/i, '<img decoding="async"');
      if (!/\breferrerpolicy\s*=/i.test(out)) out = out.replace(/<img/i, '<img referrerpolicy="no-referrer"');
      return out;
    })
    .replace(/<a\b[^>]*>/gi, (tag) => {
      let out = tag;
      if (!/\btarget\s*=/i.test(out)) out = out.replace(/<a/i, '<a target="_blank"');
      if (!/\brel\s*=/i.test(out)) out = out.replace(/<a/i, '<a rel="noopener noreferrer"');
      return out;
    })
    .replace(/<video\b(?![^>]*\bcontrols\b)[^>]*>/gi, (tag) => tag.replace(/<video/i, '<video controls'))
    .replace(/<input\b(?![^>]*\bdisabled\b)([^>]*type\s*=\s*["']?checkbox[^>]*)>/gi, '<input disabled$1>');
};

/** Sanitize GitHub-rendered HTML (DOMPurify in the browser, string fallback without DOM). */
export const sanitizeGitHubHtml = (html: string): string => {
  if (!html) return '';
  if (typeof window !== 'undefined' && DOMPurify.isSupported) {
    const clean = DOMPurify.sanitize(html, GITHUB_SANITIZE_CONFIG) as unknown as string;
    return enrichSanitizedHtml(String(clean));
  }
  return enrichSanitizedHtml(fallbackSanitizeGitHubHtml(html));
};

const SANITIZE_CACHE_MAX_CHARS = 2_000_000;
const sanitizeCache = new Map<string, string>();
let sanitizeCacheChars = 0;

/** Memoized sanitization by exact HTML string (bounded by total characters). */
export const getSanitizedGitHubHtml = (html: string): string => {
  const cached = sanitizeCache.get(html);
  if (cached !== undefined) {
    sanitizeCache.delete(html);
    sanitizeCache.set(html, cached);
    return cached;
  }
  const clean = sanitizeGitHubHtml(html);
  sanitizeCacheChars += html.length + clean.length;
  sanitizeCache.set(html, clean);
  while (sanitizeCacheChars > SANITIZE_CACHE_MAX_CHARS && sanitizeCache.size > 1) {
    const oldest = sanitizeCache.keys().next();
    if (oldest.done) break;
    const evicted = sanitizeCache.get(oldest.value);
    sanitizeCache.delete(oldest.value);
    if (evicted !== undefined) sanitizeCacheChars -= oldest.value.length + evicted.length;
    else sanitizeCacheChars -= oldest.value.length;
  }
  return clean;
};

export const IMAGE_UNAVAILABLE_LABEL = 'Image unavailable — open on GitHub';

/**
 * GitHub-rendered body (`bodyHTML`): sanitized HTML with the shared
 * `markdown-content` typography. Links open externally via delegated clicks;
 * failed images (expired signed URLs) are replaced with an external link.
 */
export const GitHubRichBody: React.FC<{ html: string; fallbackUrl?: string | null }> = ({ html, fallbackUrl }) => {
  const clean = React.useMemo(() => getSanitizedGitHubHtml(html), [html]);
  const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(anchor.href);
  }, []);
  const handleImageError = React.useCallback(
    (event: React.SyntheticEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (!(target instanceof HTMLImageElement) || target.dataset.ghFallbackApplied) return;
      target.dataset.ghFallbackApplied = 'true';
      const anchor = target.closest('a');
      const href = anchor?.getAttribute('href') || fallbackUrl || null;
      if (!href || typeof document === 'undefined') {
        target.style.display = 'none';
        return;
      }
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = IMAGE_UNAVAILABLE_LABEL;
      link.className = 'typography-micro underline underline-offset-2';
      target.replaceWith(link);
    },
    [fallbackUrl],
  );
  if (!clean.trim()) return null;
  return (
    <div
      className="markdown-content leading-relaxed min-w-0 break-words [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-md [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-[var(--surface-muted)] [&_pre]:p-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: clean }}
      onClick={handleClick}
      onErrorCapture={handleImageError}
    />
  );
};
