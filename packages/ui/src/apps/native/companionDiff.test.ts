import { expect, test } from 'bun:test';
import { companionDiffLines } from './companionDiff';

test('unified diff numbers both sides independently and resets at each hunk', () => {
  const rows = companionDiffLines('--- a/File.kt\r\n+++ b/File.kt\r\n@@ -10,2 +20,3 @@\r\n same\r\n-old\r\n+new\r\n+\r\n\\ No newline at end of file\r\n@@ -50 +60 @@\r\n last');
  expect(rows.slice(3, 7)).toEqual([
    { text: ' same', kind: 'context', oldLine: 10, newLine: 20 },
    { text: '-old', kind: 'remove', oldLine: 11 },
    { text: '+new', kind: 'add', newLine: 21 },
    { text: '+', kind: 'add', newLine: 22 },
  ]);
  expect(rows[7].kind).toBe('meta');
  expect(rows.at(-1)).toEqual({ text: ' last', kind: 'context', oldLine: 50, newLine: 60 });
});

test('file headers and binary notices remain metadata and do not get line numbers', () => {
  const rows = companionDiffLines('@@ -1 +1 @@\n+new\ndiff --git a/b b/b\n--- a/b\n+++ b/b\nBinary files differ');
  expect(rows.slice(2).every((row) => row.kind === 'meta' && row.oldLine === undefined && row.newLine === undefined)).toBe(true);
});
