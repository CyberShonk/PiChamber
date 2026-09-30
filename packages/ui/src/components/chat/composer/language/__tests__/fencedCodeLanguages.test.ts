import { beforeEach, describe, expect, test } from 'bun:test';
import { StreamLanguage } from '@codemirror/language';

const {
    __setFencedLanguagePackLoaderForTests,
    clearFencedLanguageCacheForTests,
    getLoadedFencedLanguage,
    loadFencedLanguage,
} = await import('../fencedCodeLanguages');

describe('fencedCodeLanguages loader cache', () => {
    beforeEach(() => {
        clearFencedLanguageCacheForTests();
    });

    test('loads once: sequential calls share the cached language', async () => {
        const first = await loadFencedLanguage('py');
        expect(first).not.toBeNull();
        expect(getLoadedFencedLanguage('py')).toBe(first);
        expect(getLoadedFencedLanguage('PY')).toBe(first);

        // Same info resolves from cache without refetching.
        const third = await loadFencedLanguage('py');
        expect(third).toBe(first);

        // Aliases share the pack but have distinct cache keys; both resolve.
        const alias = await loadFencedLanguage('python');
        expect(alias).not.toBeNull();
    });

    test('concurrent requests share one promise', async () => {
        const [a, b, c] = await Promise.all([
            loadFencedLanguage('py'),
            loadFencedLanguage('py'),
            loadFencedLanguage('PY'),
        ]);
        expect(a).not.toBeNull();
        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    test('unknown extension resolves to null without caching a language', async () => {
        const result = await loadFencedLanguage('definitely-unknown-xyz');
        expect(result).toBeNull();
        expect(getLoadedFencedLanguage('definitely-unknown-xyz')).toBeNull();
        // A later known load still works.
        const python = await loadFencedLanguage('py');
        expect(python).not.toBeNull();
    });

    test('failure resolves to null and retry is allowed later', async () => {
        let calls = 0;
        __setFencedLanguagePackLoaderForTests(async () => {
            calls += 1;
            if (calls === 1) throw new Error('boom');
            return StreamLanguage.define({ name: 'shell-test', token: () => null });
        });
        // Concurrent failures share one promise (one underlying load).
        const [first, second] = await Promise.all([
            loadFencedLanguage('sh'),
            loadFencedLanguage('sh'),
        ]);
        expect(first).toBeNull();
        expect(second).toBeNull();
        expect(calls).toBe(1);
        expect(getLoadedFencedLanguage('sh')).toBeNull();

        // Retry allowed: the next call re-invokes the loader and caches.
        const retried = await loadFencedLanguage('sh');
        expect(retried).not.toBeNull();
        expect(calls).toBe(2);
        expect(getLoadedFencedLanguage('sh')).toBe(retried);
    });

    test('empty info resolves to null', async () => {
        expect(await loadFencedLanguage('')).toBeNull();
        expect(await loadFencedLanguage('   ')).toBeNull();
        expect(getLoadedFencedLanguage('')).toBeNull();
    });
});
