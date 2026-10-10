import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Execute production vendor modules, rather than relying on a successful build.
// This catches initialization cycles before React can mount an error boundary.
// It is a module check, not a browser/device rendering test.
const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.argv[2] ?? path.join(mobileRoot, 'dist'));
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const entry = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"/]+\.js)"/);
if (!entry) throw new Error('Prepared mobile entry script was not found.');
const source = await readFile(path.join(dist, entry[1].slice(1)), 'utf8');
const chunks = [...new Set(`${html}\n${source}`.match(/assets\/vendor-(?:react|boot)-[^"/]+\.js/g) ?? [])];
if (chunks.length !== 2) {
  throw new Error('Expected React and boot vendor modules in the prepared mobile entry. Build mobile assets first.');
}

// Test both entry orders: module-preload order must not determine correctness.
for (const order of [chunks, [...chunks].reverse()]) {
  const urls = order.map((chunk) => pathToFileURL(path.join(dist, chunk)).href);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.window = {};
    try {
      for (const url of ${JSON.stringify(urls)}) await import(url);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  `], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error ?? 'Vendor initialization failed.'));
    process.exit(1);
  }
}
console.log('Mobile production vendor initialization passed in both entry orders.');
