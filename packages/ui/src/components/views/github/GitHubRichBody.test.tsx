// Sanitizer security: active content stripped, images constrained, links forced external.
import { describe, expect, test } from 'bun:test';
import { sanitizeGitHubHtml } from './GitHubRichBody';

describe('sanitizeGitHubHtml', () => {
  test('strips active content and forces external links', () => {
    const out = sanitizeGitHubHtml(
      '<p>hi</p><script>alert(1)</script><style>.x{}</style><iframe src="https://evil.example"></iframe><img width="1003" height="1018" alt="shot" src="https://example.com/a.png" onerror="alert(1)" /><a href="javascript:alert(1)">x</a><a href="https://github.com/o/r/pull/1">pr</a>',
    );
    expect(out).toContain('<p>hi</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('https://example.com/a.png');
    expect(out).toContain('width="1003"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  // Bun's test env has no `window`, so this exercises the string-fallback
  // path (the browser DOMPurify path now enriches via an
  // `afterSanitizeAttributes` hook instead of regex rewrites).
  test('attribute-breakout payloads yield no executable attributes', () => {
    const out = sanitizeGitHubHtml(
      '<img src="https://example.com/a.png" title="<a onerror=alert(1) ">' +
        '<a href="https://github.com/o/r/pull/1" title="<img src=x onerror=alert(2)>">pr</a>',
    );
    // The payload survives only as escaped text; strip quoted values so the
    // assertion covers real attribute names, not escaped content.
    const attrNamesOnly = out.replace(/="[^"]*"/g, '=""');
    expect(attrNamesOnly).not.toContain('onerror');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('>pr</a>');
  });
});
