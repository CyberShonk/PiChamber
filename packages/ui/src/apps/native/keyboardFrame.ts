type NativeKeyboardFrame = { height: number; durationMs: number; curve: number; settled: boolean; reduceMotion: boolean };
const curves = ['ease-in-out', 'ease-in', 'ease-out', 'linear'];
/** Reject malformed bridge events and clamp geometry to the actual viewport. */
export const normalizeKeyboardFrame = (value: unknown, viewportHeight: number): (NativeKeyboardFrame & { easing: string }) | null => {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Partial<NativeKeyboardFrame>;
  if (!Number.isFinite(frame.height) || !Number.isFinite(frame.durationMs)) return null;
  return {
    height: Math.max(0, Math.min(frame.height!, Math.max(0, viewportHeight))),
    durationMs: frame.reduceMotion ? 0 : Math.max(0, Math.min(frame.durationMs!, 1000)),
    curve: typeof frame.curve === 'number' ? frame.curve : 0,
    settled: frame.settled === true,
    reduceMotion: frame.reduceMotion === true,
    easing: curves[frame.curve ?? 0] ?? 'cubic-bezier(0.2, 0.7, 0.2, 1)',
  };
};
