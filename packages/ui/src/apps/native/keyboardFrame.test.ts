import { describe, expect, test } from 'bun:test';
import { normalizeKeyboardFrame } from './keyboardFrame';

describe('native keyboard geometry', () => {
  test('uses reported duration and curve rather than fixed choreography', () => {
    expect(normalizeKeyboardFrame({ height: 310, durationMs: 420, curve: 2 }, 800)).toMatchObject({ height: 310, durationMs: 420, easing: 'ease-out' });
  });
  test('clips rotation geometry to the viewport and clamps invalid timing', () => {
    expect(normalizeKeyboardFrame({ height: 900, durationMs: -1 }, 400)).toMatchObject({ height: 400, durationMs: 0 });
  });
  test('interactive dismissal accepts zero duration and zero inset', () => {
    expect(normalizeKeyboardFrame({ height: 0, durationMs: 0, settled: true }, 800)).toMatchObject({ height: 0, durationMs: 0, settled: true });
  });
  test('Reduce Motion removes animation', () => {
    expect(normalizeKeyboardFrame({ height: 200, durationMs: 400, reduceMotion: true }, 800)?.durationMs).toBe(0);
  });
  test('rejects missing, nonnumeric and nonfinite geometry', () => {
    for (const value of [null, {}, { height: NaN, durationMs: 200 }, { height: '310', durationMs: 200 }, { height: 310, durationMs: Infinity }]) expect(normalizeKeyboardFrame(value, 800)).toBeNull();
  });
});
