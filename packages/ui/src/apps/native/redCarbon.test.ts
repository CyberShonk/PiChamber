import { describe, expect, test } from 'bun:test';
import theme from './red-carbon-dark.json';
import { isValidTheme } from '@/contexts/theme-validation';
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe('native Red Carbon theme', () => {
  test('satisfies the complete theme contract', () => expect(isValidTheme(theme)).toBe(true));
  test('retains the supplied matte palette and structural red', () => {
    expect(theme.colors.surface.background).toBe('#070809');
    expect(theme.colors.surface.elevated).toBe('#101214');
    expect(theme.colors.primary.base).toBe('#B3121B');
  });
  test('primary, secondary, selected and button text meet small-text contrast', () => {
    for (const [foreground, background] of [[theme.colors.primary.emphasis, theme.colors.surface.background], [theme.colors.surface.foreground, theme.colors.surface.background], [theme.colors.surface.mutedForeground, theme.colors.surface.elevated], [theme.colors.primary.foreground, theme.colors.primary.base], [theme.colors.primary.foreground, theme.colors.primary.active], [theme.colors.surface.mutedForeground, theme.colors.interactive.selection], [theme.colors.interactive.selectionForeground, theme.colors.interactive.selection]]) expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
  test('semantic text remains legible on graphite', () => {
    for (const color of [theme.colors.status.error, theme.colors.status.success, theme.colors.status.warning, theme.colors.status.info]) expect(contrast(color, theme.colors.surface.background)).toBeGreaterThanOrEqual(4.5);
  });
});
