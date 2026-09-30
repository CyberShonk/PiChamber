import { describe, expect, it } from 'vitest';

import {
  THEME_COLORS,
  THEME_BG_COLORS,
  createExtensionTheme,
} from './extension-theme.js';

describe('extension-theme', () => {
  it('pins the canonical THEME_COLORS and THEME_BG_COLORS lists in exact order', () => {
    expect(THEME_COLORS).toEqual([
      'accent',
      'border',
      'borderAccent',
      'borderMuted',
      'success',
      'error',
      'warning',
      'muted',
      'dim',
      'text',
      'thinkingText',
      'scrollbarTrack',
      'scrollbarThumb',
      'searchMatchText',
      'userMessageText',
      'customMessageText',
      'customMessageLabel',
      'toolTitle',
      'toolOutput',
      'mdHeading',
      'mdLink',
      'mdLinkUrl',
      'mdCode',
      'mdCodeBlock',
      'mdCodeBlockBorder',
      'mdQuote',
      'mdQuoteBorder',
      'mdHr',
      'mdListBullet',
      'toolDiffAdded',
      'toolDiffRemoved',
      'toolDiffContext',
      'syntaxComment',
      'syntaxKeyword',
      'syntaxFunction',
      'syntaxVariable',
      'syntaxString',
      'syntaxNumber',
      'syntaxType',
      'syntaxOperator',
      'syntaxPunctuation',
      'thinkingOff',
      'thinkingMinimal',
      'thinkingLow',
      'thinkingMedium',
      'thinkingHigh',
      'thinkingXhigh',
      'thinkingMax',
      'bashMode',
    ]);

    expect(THEME_BG_COLORS).toEqual([
      'selectedBg',
      'searchMatchBg',
      'userMessageBg',
      'customMessageBg',
      'toolPendingBg',
      'toolSuccessBg',
      'toolErrorBg',
    ]);
  });

  it('implements all public Theme interface members with truecolor marker tuples', () => {
    const theme = createExtensionTheme();
    expect(theme.name).toBe('pichamber');
    expect(theme.getColorMode()).toBe('truecolor');

    // Foreground styling
    const successIndex = THEME_COLORS.indexOf('success');
    expect(theme.getFgAnsi('success')).toBe(`\x1b[38;2;1;1;${successIndex}m`);
    expect(theme.fg('success', 'ok')).toBe(`\x1b[38;2;1;1;${successIndex}mok\x1b[39m`);

    // Background styling
    const selectedBgIndex = THEME_BG_COLORS.indexOf('selectedBg');
    expect(theme.getBgAnsi('selectedBg')).toBe(`\x1b[48;2;1;1;${selectedBgIndex}m`);
    expect(theme.bg('selectedBg', 'item')).toBe(`\x1b[48;2;1;1;${selectedBgIndex}mitem\x1b[49m`);

    // SGR styles
    expect(theme.bold('bold text')).toBe('\x1b[1mbold text\x1b[22m');
    expect(theme.italic('italic text')).toBe('\x1b[3mitalic text\x1b[23m');
    expect(theme.underline('underlined text')).toBe('\x1b[4munderlined text\x1b[24m');
    expect(theme.inverse('inverse text')).toBe('\x1b[7minverse text\x1b[27m');
    expect(theme.strikethrough('struck text')).toBe('\x1b[9mstruck text\x1b[29m');

    // Thinking and bash mode border helpers
    const thinkingHighIndex = THEME_COLORS.indexOf('thinkingHigh');
    const thinkingBorder = theme.getThinkingBorderColor('high');
    expect(thinkingBorder('---')).toBe(`\x1b[38;2;1;1;${thinkingHighIndex}m---\x1b[39m`);

    const thinkingOffIndex = THEME_COLORS.indexOf('thinkingOff');
    const unknownThinkingBorder = theme.getThinkingBorderColor('unknownLevel');
    expect(unknownThinkingBorder('---')).toBe(`\x1b[38;2;1;1;${thinkingOffIndex}m---\x1b[39m`);

    const bashModeIndex = THEME_COLORS.indexOf('bashMode');
    const bashBorder = theme.getBashModeBorderColor();
    expect(bashBorder('$$$')).toBe(`\x1b[38;2;1;1;${bashModeIndex}m$$$\x1b[39m`);
  });

  it('handles unknown color names gracefully without throwing', () => {
    const theme = createExtensionTheme();
    expect(theme.getFgAnsi('nonExistentColor')).toBe('');
    expect(theme.getBgAnsi('nonExistentBg')).toBe('');
    expect(theme.fg('nonExistentColor', 'fallback text')).toBe('fallback text');
    expect(theme.bg('nonExistentBg', 'fallback text')).toBe('fallback text');
  });
});
