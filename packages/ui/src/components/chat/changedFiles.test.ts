import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/chat/types';
import { createTextDiffDataFromPatch } from '@/components/views/diff/diffFormatters';
import { extractChangedFiles } from './changedFiles';

const patch = '@@ -10,3 +10,4 @@\n context\n-before\n+after\n+added\n tail\n';
const edit = (
    id: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
    status = 'completed',
): ToolPart => ({ id, type: 'tool', tool: 'edit', state: { status, input, metadata } });

describe('extractChangedFiles recorded patches', () => {
    test('retains the top-level patch with the tool input path and its totals', () => {
        const files = extractChangedFiles([edit('edit-1', { path: 'src/file.ts' }, { patch })]);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ path: 'src/file.ts', patch, additions: 2, deletions: 1 });
    });

    test('prefers a unified patch over Pi display diff text', () => {
        const files = extractChangedFiles([edit('edit-1', { filePath: 'src/file.ts' }, {
            patch,
            diff: '-11 before\n+11 after\n+12 added',
        })]);
        expect(files[0]?.patch).toBe(patch);
    });

    test('retains a pathless patch so Last turn can render it instead of fetching a file named Diff', () => {
        const files = extractChangedFiles([edit('edit-1', {}, { diff: patch })]);
        expect(files[0]).toMatchObject({ path: 'Diff', patch, additions: 2, deletions: 1 });

        const snapshot = createTextDiffDataFromPatch(files[0]!.path, files[0]!.patch!, 'patch');
        expect(snapshot.fileDiff?.hunks).toHaveLength(1);
        expect(snapshot.fileDiff?.additionLines.join('')).toContain('after');
        expect(snapshot.fileDiff?.deletionLines.join('')).toContain('before');
    });

    test('does not invent a Diff file for a second edit of a known input path', () => {
        const files = extractChangedFiles([
            edit('edit-1', { path: 'src/file.ts' }, { patch }),
            edit('edit-2', { path: 'src/file.ts' }, { patch }),
        ]);
        expect(files.map((file) => file.path)).toEqual(['src/file.ts']);
    });

    test('does not invent a Diff file for duplicate metadata file paths', () => {
        const metadata = { files: [{ relativePath: 'src/file.ts', patch }], patch };
        const files = extractChangedFiles([edit('edit-1', {}, metadata), edit('edit-2', {}, metadata)]);
        expect(files.map((file) => file.path)).toEqual(['src/file.ts']);
        expect(files[0]?.patch).toBe(patch);
    });

    test('preserves per-file patches and ignores unsuccessful tools', () => {
        const files = extractChangedFiles([
            edit('edit-1', {}, { files: [{ relativePath: 'src/a.ts', patch, additions: 2, deletions: 1 }] }),
            edit('edit-2', {}, { filediff: { file: 'src/b.ts', patch } }),
            edit('edit-3', {}, { results: [{ filediff: { file: 'src/c.ts', patch } }] }),
            edit('failed', { path: 'src/failed.ts' }, { patch }, 'error'),
            edit('running', { path: 'src/running.ts' }, { patch }, 'running'),
        ]);
        expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
        expect(files.every((file) => file.patch === patch)).toBe(true);
    });
});
