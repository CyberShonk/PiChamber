import { describe, expect, test } from 'bun:test';
import { isValidOfflineCopy, type OfflineCopy } from './copyLimits';
const copy: OfflineCopy = { id: 'copy', runtimeKey: 'host-a', sessionId: 'session-a', title: 'Session', host: 'Pi', savedAt: 100, text: 'hello' };
describe('offline copy safety limits', () => {
  test('accepts a complete scoped snapshot', () => expect(isValidOfflineCopy(copy)).toBe(true));
  test('rejects truncated, unscoped or malformed copies', () => {
    for (const value of [null, {}, { ...copy, runtimeKey: '' }, { ...copy, savedAt: NaN }, { ...copy, text: 3 }]) expect(isValidOfflineCopy(value)).toBe(false);
  });
  test('UTF-8 bytes, not character count, determine the limit', () => {
    expect(isValidOfflineCopy({ ...copy, text: 'a'.repeat(400000) })).toBe(true);
    expect(isValidOfflineCopy({ ...copy, text: 'é'.repeat(400000) })).toBe(false);
  });
  test('metadata counts toward the same storage budget', () => expect(isValidOfflineCopy({ ...copy, title: 'x'.repeat(600000) })).toBe(false));
});
