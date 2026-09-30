import React from 'react';

/* ─────────────────────────────────────────────────────────
 * Compositor-only "working" shimmer highlight.
 *
 * Render inside a host carrying `oc-shimmer-host` (or `oc-shimmer-verb` /
 * `pixel-loader-label`, which include it). The host draws the text in the
 * dim base color; this overlay draws the same text in the bright color
 * through a soft mask window. The window slides and the text inside it
 * counter-slides, so the glyphs stay put while the highlight sweeps —
 * the same look as the old background-position gradient, but animating
 * `transform` only, so frames never repaint (~68ms/s → ~4ms/s measured).
 *
 * The highlight text comes from CSS `content: attr(...)`, so it never
 * enters innerText, copy, export, or text selection; `aria-hidden` keeps
 * it out of the accessibility tree.
 * ───────────────────────────────────────────────────────── */
export const ShimmerGlint: React.FC<{ text: string }> = ({ text }) => (
  <span aria-hidden="true" className="oc-shimmer-clip">
    <span className="oc-shimmer-band" data-shimmer-text={text} />
  </span>
);
