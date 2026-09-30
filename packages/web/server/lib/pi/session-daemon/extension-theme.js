/**
 * PiChamber Theme implementation for pi extensions.
 *
 * Implements the full public Theme interface from Pi SDK (@earendil-works/pi-coding-agent).
 * Encodes semantic ThemeColor (fg) and ThemeBg (bg) values as standard SGR truecolor
 * escape sequences with a reserved marker tuple (r=1, g=1, b=index):
 *   fg: \x1b[38;2;1;1;<index>m … \x1b[39m
 *   bg: \x1b[48;2;1;1;<index>m … \x1b[49m
 *
 * Width-measuring code (such as pi-tui visibleWidth) treats these as standard ANSI
 * SGR sequences, while PiChamber UI parses the marker into theme CSS variables.
 *
 * IMPORTANT: THEME_COLORS and THEME_BG_COLORS must stay strictly in sync with
 * packages/ui/src/lib/pi/ansi.ts on the client side.
 */

export const THEME_COLORS = Object.freeze([
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

export const THEME_BG_COLORS = Object.freeze([
  'selectedBg',
  'searchMatchBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
]);

const FG_INDEX_MAP = new Map(THEME_COLORS.map((name, index) => [name, index]));
const BG_INDEX_MAP = new Map(THEME_BG_COLORS.map((name, index) => [name, index]));

/**
 * Creates a Theme-compatible instance implementing all public Theme members.
 */
export const createExtensionTheme = () => {
  const getFgAnsi = (color) => {
    const index = FG_INDEX_MAP.get(color);
    return index !== undefined ? `\x1b[38;2;1;1;${index}m` : '';
  };

  const getBgAnsi = (color) => {
    const index = BG_INDEX_MAP.get(color);
    return index !== undefined ? `\x1b[48;2;1;1;${index}m` : '';
  };

  const fg = (color, text) => {
    const ansi = getFgAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[39m`;
  };

  const bg = (color, text) => {
    const ansi = getBgAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[49m`;
  };

  const bold = (text) => `\x1b[1m${text}\x1b[22m`;
  const italic = (text) => `\x1b[3m${text}\x1b[23m`;
  const underline = (text) => `\x1b[4m${text}\x1b[24m`;
  const inverse = (text) => `\x1b[7m${text}\x1b[27m`;
  const strikethrough = (text) => `\x1b[9m${text}\x1b[29m`;

  const getColorMode = () => 'truecolor';

  const getThinkingBorderColor = (level) => {
    const cap = typeof level === 'string' && level.length > 0
      ? level.charAt(0).toUpperCase() + level.slice(1)
      : '';
    const candidate = `thinking${cap}`;
    const color = FG_INDEX_MAP.has(candidate) ? candidate : 'thinkingOff';
    return (str) => fg(color, str);
  };

  const getBashModeBorderColor = () => (str) => fg('bashMode', str);

  return {
    name: 'pichamber',
    fg,
    bg,
    bold,
    italic,
    underline,
    inverse,
    strikethrough,
    getFgAnsi,
    getBgAnsi,
    getColorMode,
    getThinkingBorderColor,
    getBashModeBorderColor,
  };
};
