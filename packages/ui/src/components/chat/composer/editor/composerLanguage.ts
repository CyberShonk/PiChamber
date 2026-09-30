/**
 * The composer's prompt language as a CodeMirror extension.
 *
 * `tokenizeComposer` already answers "what does this text mean"; this module
 * is the thin adapter that turns its ranges into mark decorations and keeps
 * them in sync with the document and with the workspace registries.
 *
 * Why this replaces the mirror overlay: a transparent textarea painted over a
 * mirror div can only use styles that do not change glyph advance width, or
 * the two layers drift apart and the caret lands in the wrong place. That is
 * why bold and italic were never highlighted, and why the overlay had to be
 * switched off entirely on mobile. CodeMirror owns the caret and the text, so
 * there is no second layer to keep aligned and no metric restriction.
 */

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

import { resolveHighlightSegments, DEFAULT_HIGHLIGHT_CLASS } from '../../composerHighlight';
import { preloadFencedCodeLanguages } from '../../composerCodeHighlight';
import { tokenizeComposer, type ComposerLanguageContext } from '../language/tokenize';

/**
 * Replace the workspace knowledge the tokenizer resolves against. Dispatched
 * when the agent, command, skill, snippet or attachment registries change —
 * not on every keystroke, which only changes the document.
 */
export const setLanguageContext = StateEffect.define<ComposerLanguageContext>();

/**
 * Recompute decorations after an on-demand fenced-code language arrives.
 * `highlightFencedCode` renders uniform `codeFence` styling until the pack
 * loads; this effect repaints the same document with per-token colors once
 * `preloadFencedCodeLanguages` resolves true. It never changes the document.
 */
export const codeLanguagesChanged = StateEffect.define<void>();

/**
 * The context lives in editor state rather than in a closure so the decoration
 * field can recompute from `(document, context)` alone, and so a context change
 * repaints without remounting the view.
 */
const languageContextField = StateField.define<ComposerLanguageContext>({
    create: () => EMPTY_CONTEXT,
    update(value, transaction) {
        for (const effect of transaction.effects) {
            if (effect.is(setLanguageContext)) return effect.value;
        }
        return value;
    },
});

export const EMPTY_CONTEXT: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
};

/**
 * Decorations for the whole document. The composer holds a prompt, not a
 * source file: it is short enough that a full retokenize per change is
 * cheaper and far simpler than incremental mapping, and it keeps the editor
 * and the send path reading the exact same grammar.
 */
function buildDecorations(text: string, context: ComposerLanguageContext): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const segment of resolveHighlightSegments(text, tokenizeComposer(text, context))) {
        // Unstyled stretches need no decoration — the editor's own base text
        // color already renders them.
        if (segment.className === DEFAULT_HIGHLIGHT_CLASS) continue;
        builder.add(segment.start, segment.end, Decoration.mark({ class: segment.className }));
    }
    return builder.finish();
}

const decorationField = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state.doc.toString(), state.field(languageContextField)),
    update(value, transaction) {
        const contextChanged = transaction.effects.some((effect) => effect.is(setLanguageContext));
        const codeChanged = transaction.effects.some((effect) => effect.is(codeLanguagesChanged));
        if (!transaction.docChanged && !contextChanged && !codeChanged) return value;
        return buildDecorations(
            transaction.state.doc.toString(),
            transaction.state.field(languageContextField),
        );
    },
    provide: (field) => EditorView.decorations.from(field),
});

/**
 * Watches the document for fenced-code languages that have not loaded yet,
 * starts their packs, and dispatches `codeLanguagesChanged` when a new pack
 * arrives so the same text repaints with per-token colors. Concurrent edits
 * share the loader's deduped promise; a dispatch only fires when the loaded
 * text is still current, so there is no flicker loop or repeated loading —
 * after the cache fills, `preloadFencedCodeLanguages` resolves false and no
 * further effects dispatch.
 */
const fencedCodeLanguagePlugin = ViewPlugin.fromClass(
    class {
        private generation = 0;

        constructor(view: EditorView) {
            void this.ensure(view);
        }

        update(update: ViewUpdate) {
            if (update.docChanged) void this.ensure(update.view);
        }

        private async ensure(view: EditorView) {
            const generation = ++this.generation;
            const text = view.state.doc.toString();
            if (!text.includes('```') && !text.includes('~~~')) return;
            let changed = false;
            try {
                changed = await preloadFencedCodeLanguages(text);
            } catch {
                return;
            }
            if (generation !== this.generation) return;
            if (!changed) return;
            if (view.state.doc.toString() !== text) return;
            view.dispatch({ effects: codeLanguagesChanged.of(undefined) });
        }
    },
);

/**
 * The composer language extension. Install once; feed it registry updates with
 * `setLanguageContext`. Fenced-code packs load on demand through the bundled
 * view plugin, which dispatches `codeLanguagesChanged` when a pack arrives.
 */
export function composerLanguage(initial: ComposerLanguageContext = EMPTY_CONTEXT) {
    return [
        languageContextField.init(() => initial),
        decorationField,
        fencedCodeLanguagePlugin,
    ];
}

/** The context currently in effect, for callers that need to read it back. */
