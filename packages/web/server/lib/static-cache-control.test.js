import path from 'path';
import { describe, expect, it } from 'vitest';

import { resolveStaticCacheControl } from './static-cache-control.js';

const dist = path.join(path.sep, 'app', 'dist');
const at = (...segments) => path.join(dist, ...segments);

describe('resolveStaticCacheControl', () => {
  it('caches content-hashed build assets as immutable', () => {
    expect(resolveStaticCacheControl(dist, at('assets', 'main-o4e0qQwZ.js'))).toBe('public, max-age=31536000, immutable');
    expect(resolveStaticCacheControl(dist, at('assets', 'index-BZ_7-XLh.css'))).toBe('public, max-age=31536000, immutable');
  });

  it('keeps unhashed or out-of-assets files revalidating', () => {
    expect(resolveStaticCacheControl(dist, at('index.html'))).toBeNull();
    expect(resolveStaticCacheControl(dist, at('apple-touch-icon.png'))).toBeNull();
    expect(resolveStaticCacheControl(dist, at('assets', 'logo.svg'))).toBeNull();
    expect(resolveStaticCacheControl(dist, at('main-o4e0qQwZ.js'))).toBeNull();
  });

  it('never caches the service worker', () => {
    expect(resolveStaticCacheControl(dist, at('sw.js'))).toBe('no-store');
  });
});
