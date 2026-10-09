import { describe, expect, test } from 'bun:test';
import { formatTranscript, transcriptEntries } from './transcript';
import type { SessionMessageRecord } from '@/lib/chat/types';

describe('explicit native transcript projection', () => {
  test('preserves code and command formatting, without exporting internal reasoning or synthetic text', () => {
    const records: SessionMessageRecord[] = [{ info: { id: 'a', role: 'assistant' }, parts: [
      { id: 't', type: 'text', text: '```swift\n  let x = 1\n```' },
      { id: 'r', type: 'reasoning', text: 'private reasoning' },
      { id: 's', type: 'text', text: 'synthetic', synthetic: true },
      { id: 'tool', type: 'tool', tool: 'bash', state: { input: { command: 'printf "a\\nb"' }, output: '  a\n  b\n' } },
    ] }];
    const entries = transcriptEntries(records);
    expect(entries[0].tools[0].command).toBe('printf "a\\nb"');
    expect(entries[0].tools[0].output).toBe('  a\n  b\n');
    expect(formatTranscript(entries)).toContain('```swift\n  let x = 1\n```');
    expect(formatTranscript(entries)).not.toContain('private reasoning');
    expect(formatTranscript(entries)).not.toContain('synthetic');
  });
  test('recognizes message and tool errors independently', () => {
    expect(transcriptEntries([{ info: { id: 'a', error: { message: 'oops' } }, parts: [] }, { info: { id: 'b' }, parts: [{ id: 't', type: 'tool', state: { status: 'error' } }] }]).map((entry) => entry.error)).toEqual([true, true]);
  });
  test('does not stringify arbitrary tool objects as output or commands', () => {
    expect(transcriptEntries([{ info: { id: 'a' }, parts: [{ id: 't', type: 'tool', state: { input: { command: { token: 'secret' } }, output: { secret: 'hidden' } } }] }])[0].tools[0]).toMatchObject({ command: undefined, output: undefined });
  });
});
