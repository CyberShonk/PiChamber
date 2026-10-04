import * as React from 'react';
import { containsAnsiEscape, parseAnsiSegments, type AnsiSegment } from '@/lib/pi/ansi';

export interface AnsiTextProps {
  text?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

const renderSegmentStyle = (segment: AnsiSegment): React.CSSProperties | undefined => {
  const segStyle: React.CSSProperties = {};
  let hasStyle = false;

  let fg = segment.fg;
  let bg = segment.bg;

  if (segment.inverse) {
    // Swap foreground and background when inverse is requested
    const temp = fg;
    fg = bg ?? 'var(--surface-background, var(--background))';
    bg = temp ?? 'var(--foreground)';
    hasStyle = true;
  }

  if (fg) {
    segStyle.color = fg;
    hasStyle = true;
  }
  if (bg) {
    segStyle.backgroundColor = bg;
    hasStyle = true;
  }
  if (segment.bold) {
    segStyle.fontWeight = 600;
    hasStyle = true;
  }
  if (segment.dim) {
    segStyle.opacity = 0.65;
    hasStyle = true;
  }
  if (segment.italic) {
    segStyle.fontStyle = 'italic';
    hasStyle = true;
  }
  if (segment.underline && segment.strikethrough) {
    segStyle.textDecoration = 'underline line-through';
    hasStyle = true;
  } else if (segment.underline) {
    segStyle.textDecoration = 'underline';
    hasStyle = true;
  } else if (segment.strikethrough) {
    segStyle.textDecoration = 'line-through';
    hasStyle = true;
  }

  return hasStyle ? segStyle : undefined;
};

/**
 * Renders ANSI SGR-formatted text as structured React spans with semantic CSS variables.
 * Plain text without escape sequences renders directly with zero styling overhead.
 */
export const AnsiText: React.FC<AnsiTextProps> = React.memo(({ text, className, style }) => {
  if (text === undefined || text === null || text === '') {
    return null;
  }

  if (!containsAnsiEscape(text)) {
    if (className || style) {
      return <span className={className} style={style}>{text}</span>;
    }
    return <>{text}</>;
  }

  const segments = parseAnsiSegments(text);
  if (segments.length === 0) {
    return null;
  }

  if (segments.length === 1 && !renderSegmentStyle(segments[0]!)) {
    if (className || style) {
      return <span className={className} style={style}>{segments[0]!.text}</span>;
    }
    return <>{segments[0]!.text}</>;
  }

  return (
    <span className={className} style={style}>
      {segments.map((seg, idx) => {
        const segStyle = renderSegmentStyle(seg);
        if (!segStyle) {
          return <React.Fragment key={idx}>{seg.text}</React.Fragment>;
        }
        return (
          <span key={idx} style={segStyle}>
            {seg.text}
          </span>
        );
      })}
    </span>
  );
});

AnsiText.displayName = 'AnsiText';
