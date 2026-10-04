import { beforeEach, describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
    highlightFencedCode,
    preloadFencedCodeLanguages,
} from '../composerCodeHighlight';
import { codeLanguagesChanged, composerLanguage } from '../composer/editor/composerLanguage';
import { clearFencedLanguageCacheForTests, getLoadedFencedLanguage } from '../composer/language/fencedCodeLanguages';
import type { ComposerLanguageContext } from '../composer/language/tokenize';

const context = (overrides: Partial<ComposerLanguageContext> = {}): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
    ...overrides,
});

const stateWith = (doc: string, ctx = context()) =>
    EditorState.create({ doc, extensions: composerLanguage(ctx) });

const decorationClasses = (state: EditorState): string[] => {
    const found: string[] = [];
    const set = state.facet(EditorView.decorations)
        .map((source) => (typeof source === 'function' ? null : source))
        .find(Boolean);
    if (!set) return found;
    const iterator = set.iter();
    while (iterator.value) {
        const spec = iterator.value.spec as { class?: string };
        if (spec.class) found.push(spec.class);
        iterator.next();
    }
    return found;
};

describe('composerCodeHighlight on-demand loading', () => {
    beforeEach(() => {
        clearFencedLanguageCacheForTests();
    });

    test('renders plain until the pack arrives, then highlights', async () => {
        const text = '```py\nprint(1)\n```';
        expect(getLoadedFencedLanguage('py')).toBeNull();
        expect(highlightFencedCode(text)).toEqual([]);

        const changed = await preloadFencedCodeLanguages(text);
        expect(changed).toBe(true);
        expect(getLoadedFencedLanguage('py')).not.toBeNull();

        const ranges = highlightFencedCode(text);
        expect(ranges.length).toBeGreaterThan(0);
        // Neutral base plus at least one per-token range.
        expect(ranges.some((range) => range.className?.includes('--syntax-'))).toBe(true);
    });

    test('preload resolves false when nothing needs loading (no flicker loop)', async () => {
        const text = '```py\nprint(1)\n```';
        expect(await preloadFencedCodeLanguages(text)).toBe(true);
        // Cache is warm now: no further loading, no re-highlight needed.
        expect(await preloadFencedCodeLanguages(text)).toBe(false);
        expect(highlightFencedCode(text).length).toBeGreaterThan(0);
    });

    test('unknown languages stay plain and never report a change', async () => {
        const text = '```definitely-unknown-xyz\nsome text\n```';
        expect(await preloadFencedCodeLanguages(text)).toBe(false);
        expect(highlightFencedCode(text)).toEqual([]);
        expect(await preloadFencedCodeLanguages(text)).toBe(false);
    });

    test('text without fences needs no loading', async () => {
        expect(await preloadFencedCodeLanguages('just prose')).toBe(false);
        expect(await preloadFencedCodeLanguages('')).toBe(false);
    });

    test('re-highlight actually happens when the language finishes loading', async () => {
        const text = '```py\nprint(1)\n```';
        const before = stateWith(text);
        expect(decorationClasses(before).some((cls) => cls.includes('--syntax-'))).toBe(false);

        await preloadFencedCodeLanguages(text);
        const after = before.update({ effects: codeLanguagesChanged.of(undefined) }).state;
        expect(decorationClasses(after).some((cls) => cls.includes('--syntax-'))).toBe(true);
        expect(after.doc.toString()).toBe(text);
    });

    test('dispatching without a loaded language keeps plain styling', () => {
        const text = '```definitely-unknown-xyz\nsome text\n```';
        const before = stateWith(text);
        const after = before.update({ effects: codeLanguagesChanged.of(undefined) }).state;
        expect(decorationClasses(after).some((cls) => cls.includes('--syntax-'))).toBe(false);
    });
});
