type CompanionDiffLine = { text: string; kind: 'meta' | 'hunk' | 'add' | 'remove' | 'context'; oldLine?: number; newLine?: number };
/** Preserve unified diff content, including blank lines and no-newline markers. */
export const companionDiffLines = (content: string): CompanionDiffLine[] => {
  let oldLine: number | undefined, newLine: number | undefined;
  return content.replace(/\r\n/g, '\n').split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
      return { text, kind: 'hunk' };
    }
    if (text.startsWith('diff --git ')) { oldLine = undefined; newLine = undefined; }
    if (oldLine === undefined || newLine === undefined) return { text, kind: 'meta' };
    if (text.startsWith('+')) return { text, kind: 'add', newLine: newLine++ };
    if (text.startsWith('-')) return { text, kind: 'remove', oldLine: oldLine++ };
    if (text.startsWith(' ')) return { text, kind: 'context', oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: 'meta' };
  });
};
