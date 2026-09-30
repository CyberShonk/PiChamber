import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  __resetFileTypeSpriteForTests,
  __setFileTypeSpriteLoaderForTests,
  loadFileTypeSprite,
} from '@/lib/fileTypeIcons';
import { FileTypeIcon } from './FileTypeIcon';

const FAKE_SPRITE = [
  '<svg xmlns="http://www.w3.org/2000/svg">',
  '<symbol id="typescript" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>',
  '</svg>',
].join('');

describe('FileTypeIcon', () => {
  test('renders the synchronous href before the sprite has loaded', () => {
    __resetFileTypeSpriteForTests();
    __setFileTypeSpriteLoaderForTests(() => new Promise<{ default: string }>(() => undefined));
    try {
      const markup = renderToStaticMarkup(<FileTypeIcon filePath="src/index.ts" />);
      expect(markup).toContain('<use href="#typescript"');
    } finally {
      __resetFileTypeSpriteForTests();
    }
  });

  test('renders the same href once the sprite has loaded', async () => {
    __resetFileTypeSpriteForTests();
    __setFileTypeSpriteLoaderForTests(() => Promise.resolve({ default: FAKE_SPRITE }));
    try {
      const before = renderToStaticMarkup(<FileTypeIcon filePath="src/index.ts" />);
      expect(before).toContain('<use href="#typescript"');
      await loadFileTypeSprite();
      const after = renderToStaticMarkup(<FileTypeIcon filePath="src/index.ts" />);
      expect(after).toContain('<use href="#typescript"');
    } finally {
      __resetFileTypeSpriteForTests();
    }
  });
});
