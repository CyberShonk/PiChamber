import path from 'path';

// Vite emits every file under `assets/` with a content hash in its name, so a
// given URL never changes bytes. Those files are cached as immutable; without
// this a reload revalidates every chunk (one round trip each), which dominates
// load time over any non-loopback link. Everything else (index.html, sw.js,
// icons, manifest) keeps revalidating so upgrades are picked up.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export const resolveStaticCacheControl = (distPath, filePath) => {
  if (filePath.endsWith(`${path.sep}sw.js`)) return 'no-store';
  const assetsDir = path.join(distPath, 'assets') + path.sep;
  if (filePath.startsWith(assetsDir) && HASHED_ASSET_NAME.test(path.basename(filePath))) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  return null;
};
