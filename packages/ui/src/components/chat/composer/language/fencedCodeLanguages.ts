/**
 * On-demand CodeMirror languages for fenced code blocks in the chat composer.
 *
 * The composer's eager startup graph (main.tsx → ChatInput → ComposerEditor →
 * composerLanguage → tokenize → composerCodeHighlight) must not statically
 * import `@codemirror/lang-*`, `@codemirror/language-data`, or
 * `@codemirror/legacy-modes`. Those packs (~230 KB raw, incl. the
 * `@lezer/*` parsers) are only needed when a fenced block with that language
 * is actually visible, so each pack loads via its own dynamic `import()`.
 * Rollup splits per dynamic import, so unused languages never download.
 *
 * Contract:
 * - `getLoadedFencedLanguage(info)` is synchronous and returns the cached
 *   `Language` or `null`. `highlightFencedCode` renders unhighlighted
 *   (uniform `codeFence`) text until the language arrives.
 * - `loadFencedLanguage(info)` is async, deduped (concurrent callers share
 *   one promise), caches successes, returns `null` for unknown infos, and on
 *   import failure returns `null` without caching so a later retry may
 *   succeed.
 *
 * The composer editor itself does not use a CodeMirror language at first
 * paint — it renders through the custom `composerLanguage` decorations — so
 * no pack (including markdown) needs to stay eager. `languageByExtension.ts`
 * keeps its synchronous imports for the file viewer, which is only reachable
 * from lazy chunks (`MainLayout`, `ContextPanel`, `MobileWorkspaceDrawer`),
 * and is therefore not part of the eager graph once the composer stops
 * importing it.
 */

import { Language, StreamLanguage } from '@codemirror/language';

type PackKey =
    | 'javascript'
    | 'json'
    | 'css'
    | 'html'
    | 'markdown'
    | 'python'
    | 'shell';

/** Normalized fence info → which pack provides its parser. */
const packForInfo = (normalized: string): PackKey | null => {
    switch (normalized) {
        case 'bash':
        case 'sh':
        case 'zsh':
        case 'shell':
        case 'shellsession':
        case 'console':
            return 'shell';
        case 'json':
        case 'jsonc':
        case 'json5':
            return 'json';
        case 'js':
        case 'javascript':
        case 'jsx':
        case 'ts':
        case 'typescript':
        case 'tsx':
            return 'javascript';
        case 'html':
        case 'heex':
        case 'eex':
        case 'leex':
            return 'html';
        case 'css':
            return 'css';
        case 'py':
        case 'python':
            return 'python';
        case 'md':
        case 'markdown':
        case 'mdown':
        case 'mkd':
            return 'markdown';
        default:
            return null;
    }
};

const normalizeInfo = (info: string): string => info.trim().toLowerCase();

const languageCache = new Map<string, Language>();
const languageInFlight = new Map<string, Promise<Language | null>>();

// Test-only override for pack loading, so failure/retry can be exercised
// without mocking npm packages (bun's mock.module is process-global and its
// factory runs once, which cannot model fail-then-succeed). Production code
// never sets this.
type PackLoader = (pack: PackKey, normalized: string) => Promise<Language | null>;
let testPackLoader: PackLoader | null = null;

export const __setFencedLanguagePackLoaderForTests = (loader: PackLoader | null): void => {
    testPackLoader = loader;
};

let cachedShellLanguage: Language | null = null;

const loadPackLanguage = async (pack: PackKey, normalized: string): Promise<Language | null> => {
    if (testPackLoader) return testPackLoader(pack, normalized);
    switch (pack) {
        case 'javascript': {
            const { javascript } = await import('@codemirror/lang-javascript');
            switch (normalized) {
                case 'jsx':
                    return javascript({ jsx: true }).language;
                case 'ts':
                case 'typescript':
                    return javascript({ typescript: true }).language;
                case 'tsx':
                    return javascript({ typescript: true, jsx: true }).language;
                default:
                    return javascript().language;
            }
        }
        case 'json': {
            const { json } = await import('@codemirror/lang-json');
            return json().language;
        }
        case 'css': {
            const { css } = await import('@codemirror/lang-css');
            return css().language;
        }
        case 'html': {
            const { html } = await import('@codemirror/lang-html');
            return html().language;
        }
        case 'markdown': {
            const { markdown } = await import('@codemirror/lang-markdown');
            return markdown().language;
        }
        case 'python': {
            const { python } = await import('@codemirror/lang-python');
            return python().language;
        }
        case 'shell': {
            if (cachedShellLanguage) return cachedShellLanguage;
            const { shell } = await import('@codemirror/legacy-modes/mode/shell');
            cachedShellLanguage = StreamLanguage.define(shell);
            return cachedShellLanguage;
        }
    }
};

/**
 * Synchronous read of the cache. Returns the loaded `Language` or `null`
 * when the info is unknown or its pack has not finished loading yet.
 */
export const getLoadedFencedLanguage = (info: string): Language | null => {
    if (!info) return null;
    return languageCache.get(normalizeInfo(info)) ?? null;
};

/**
 * Load the language for a fence info string, sharing one promise across
 * concurrent callers and caching successes. Unknown infos resolve to `null`
 * without downloading anything; import failures resolve to `null` and are
 * not cached so a later call may retry.
 */
export const loadFencedLanguage = (info: string): Promise<Language | null> => {
    const normalized = normalizeInfo(info);
    if (!normalized) return Promise.resolve(null);
    const cached = languageCache.get(normalized);
    if (cached) return Promise.resolve(cached);
    const ongoing = languageInFlight.get(normalized);
    if (ongoing) return ongoing;

    const pack = packForInfo(normalized);
    if (!pack) return Promise.resolve(null);

    const promise = loadPackLanguage(pack, normalized)
        .then((language) => {
            if (language) languageCache.set(normalized, language);
            languageInFlight.delete(normalized);
            return language;
        })
        .catch(() => {
            // Failure is not authoritative empty: leave the cache empty so a
            // later call may retry, and let the caller keep plain styling.
            languageInFlight.delete(normalized);
            return null;
        });
    languageInFlight.set(normalized, promise);
    return promise;
};

/** Reset caches. Test-only: lets focused suites isolate load-once behavior. */
export const clearFencedLanguageCacheForTests = (): void => {
    languageCache.clear();
    languageInFlight.clear();
    cachedShellLanguage = null;
    testPackLoader = null;
};
