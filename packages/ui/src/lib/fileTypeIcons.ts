import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { FILE_TYPE_ICON_IDS } from '@/lib/fileTypeIconIds';

type ThemeVariant = 'light' | 'dark';

const FILE_TYPE_SPRITE_ROOT_ID = 'oc-file-type-icon-sprite-root';
const SVG_NS = 'http://www.w3.org/2000/svg';

// The sprite holds ~2,000 symbols (~965 KB raw, ~250 KB gzip). It used to be
// imported statically, which embedded the whole string in the startup JS
// chunk even though only a handful of symbols are ever mounted. It is now
// loaded on demand in its own chunk via dynamic import: the first request
// records the symbol as pending and starts a single shared load; when the
// load resolves, the index is built once and every pending symbol is mounted.
// Mounting all of it would make it most of the document, so every full style
// recalculation walked it. Only the symbols actually referenced are mounted,
// on first use, along with any symbols they reference through <use href="#id">.
let spriteContent: string | null = null;
let spriteLoadPromise: Promise<void> | null = null;
let symbolMarkupById: Map<string, string> | null = null;
const mountedSymbolIds = new Set<string>();
const pendingSymbolIds = new Set<string>();

// Monotonic readiness version, bumped exactly once when the sprite becomes
// available. FileTypeIcon subscribes via useSyncExternalStore and re-keys its
// <use> element on change, so icons requested before the load still resolve
// in browsers that do not re-resolve an SVG forward reference whose target
// symbol is inserted later.
let spriteReadyVersion = 0;
const spriteReadyListeners = new Set<() => void>();

export const getFileTypeSpriteVersion = (): number => spriteReadyVersion;

export const subscribeFileTypeSprite = (listener: () => void): (() => void) => {
  spriteReadyListeners.add(listener);
  return () => {
    spriteReadyListeners.delete(listener);
  };
};

const notifySpriteReady = (): void => {
  spriteReadyVersion += 1;
  for (const listener of Array.from(spriteReadyListeners)) {
    listener();
  }
};

type FileTypeSpriteModule = { default: string };
type FileTypeSpriteLoader = () => Promise<FileTypeSpriteModule>;

const defaultSpriteLoader: FileTypeSpriteLoader = () =>
  import('../assets/icons/file-types/sprite.svg?raw');

let spriteLoader: FileTypeSpriteLoader = defaultSpriteLoader;

/** Test seam (follows the repo __reset*ForTests precedent): override the sprite import. */
export const __setFileTypeSpriteLoaderForTests = (loader: FileTypeSpriteLoader): void => {
  spriteLoader = loader;
};

/** Test seam: restore initial state, including the real sprite loader. */
export const __resetFileTypeSpriteForTests = (): void => {
  spriteContent = null;
  spriteLoadPromise = null;
  symbolMarkupById = null;
  mountedSymbolIds.clear();
  pendingSymbolIds.clear();
  spriteReadyVersion = 0;
  spriteReadyListeners.clear();
  spriteLoader = defaultSpriteLoader;
};

const buildSymbolMarkupIndex = (content: string): Map<string, string> => {
  const index = new Map<string, string>();
  for (const match of content.matchAll(/<symbol\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g)) {
    index.set(match[1], match[0]);
  }
  return index;
};

const getSpriteDefs = (): Element | null => {
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }

  const existing = document.getElementById(FILE_TYPE_SPRITE_ROOT_ID);
  const existingDefs = existing?.querySelector('defs');
  if (existingDefs) {
    return existingDefs;
  }

  // The root was never created or was removed: nothing is mounted anymore.
  existing?.remove();
  mountedSymbolIds.clear();

  const root = document.createElement('div');
  root.id = FILE_TYPE_SPRITE_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.style.position = 'absolute';
  root.style.width = '0';
  root.style.height = '0';
  root.style.overflow = 'hidden';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);
  root.appendChild(svg);
  document.body.appendChild(root);
  return defs;
};

const spriteDefsExist = (): boolean => {
  if (typeof document === 'undefined' || !document.body) {
    return false;
  }
  return Boolean(document.getElementById(FILE_TYPE_SPRITE_ROOT_ID)?.querySelector('defs'));
};

const mountFileTypeSymbol = (iconId: string): void => {
  const defs = getSpriteDefs();
  if (!defs || mountedSymbolIds.has(iconId) || !symbolMarkupById) {
    return;
  }
  const markup = symbolMarkupById.get(iconId);
  if (!markup) {
    return;
  }
  mountedSymbolIds.add(iconId);
  // Parsed with the <defs> context element, so the markup is SVG content.
  defs.insertAdjacentHTML('beforeend', markup);
  for (const reference of markup.matchAll(/href="#([^"]+)"/g)) {
    if (symbolMarkupById.has(reference[1])) {
      mountFileTypeSymbol(reference[1]);
    }
  }
};

const ensureFileTypeSymbol = (iconId: string): void => {
  if (mountedSymbolIds.has(iconId) && spriteDefsExist()) {
    return;
  }
  if (spriteContent === null || symbolMarkupById === null) {
    // Sprite not loaded yet (or a previous load failed and awaits retry):
    // remember the request and start the shared load. Render paths never
    // throw; the rejection is swallowed here and retried on next request.
    pendingSymbolIds.add(iconId);
    void loadFileTypeSprite().catch(() => {
      // Cleared from the cache on failure, so the next request retries.
      // Nothing here logs sprite content.
    });
    return;
  }
  pendingSymbolIds.delete(iconId);
  mountFileTypeSymbol(iconId);
};

const onSpriteLoaded = (content: string): void => {
  spriteContent = content;
  symbolMarkupById = buildSymbolMarkupIndex(content);
  // Skip touching the DOM for a pure idle preload with no pending icons.
  if (pendingSymbolIds.size > 0 && getSpriteDefs() !== null) {
    const pending = Array.from(pendingSymbolIds);
    pendingSymbolIds.clear();
    for (const iconId of pending) {
      mountFileTypeSymbol(iconId);
    }
  }
  notifySpriteReady();
};

/**
 * Starts the on-demand sprite load (single-flight) and resolves once pending
 * symbols are mounted. Rejects when the load fails; the cached promise is
 * cleared so a later call retries. Render paths must attach a catch.
 */
export const loadFileTypeSprite = (): Promise<void> => {
  if (spriteContent !== null) {
    return Promise.resolve();
  }
  if (!spriteLoadPromise) {
    spriteLoadPromise = spriteLoader().then(
      (spriteModule) => {
        spriteLoadPromise = null;
        onSpriteLoaded(
          typeof spriteModule === 'string' ? spriteModule : spriteModule.default,
        );
      },
      () => {
        // Allow a later request to retry; render paths already swallow this
        // rejection, and nothing here logs sprite content.
        spriteLoadPromise = null;
        throw new Error('file-type sprite failed to load');
      },
    );
  }
  return spriteLoadPromise;
};

const scheduleIdleSpriteLoad = (): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  const startLoad = (): void => {
    void loadFileTypeSprite().catch(() => {
      // Idle preload failure is silent; the next icon request retries.
    });
  };
  // requestIdleCallback is absent in Safari/WKWebView, hence the fallback.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => startLoad());
    return;
  }
  window.setTimeout(startLoad, 0);
};

scheduleIdleSpriteLoad();

const fileNameIconMap: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'tsconfig.json': 'tsconfig',
  'jsconfig.json': 'jsconfig',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.editorconfig': 'editorconfig',
  '.npmrc': 'npm',
  '.yarnrc': 'yarn',
  '.prettierrc': 'prettier',
  '.eslintrc': 'eslint',
  '.babelrc': 'babel',
};

const languageIconMap: Record<string, string> = {
  javascript: 'javascript',
  jsx: 'react',
  typescript: 'typescript',
  tsx: 'react_ts',
  html: 'html',
  handlebars: 'handlebars',
  twig: 'twig',
  liquid: 'liquid',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  stylus: 'stylus',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  ini: 'settings',
  properties: 'settings',
  bash: 'console',
  powershell: 'powershell',
  batch: 'console',
  python: 'python',
  ruby: 'ruby',
  erb: 'ruby',
  php: 'php',
  java: 'java',
  kotlin: 'kotlin',
  scala: 'scala',
  groovy: 'groovy',
  c: 'c',
  cpp: 'cpp',
  objectivec: 'objective-c',
  csharp: 'csharp',
  fsharp: 'fsharp',
  go: 'go',
  rust: 'rust',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  julia: 'julia',
  haskell: 'haskell',
  elixir: 'elixir',
  erlang: 'erlang',
  clojure: 'clojure',
  lisp: 'lisp',
  scheme: 'scheme',
  ocaml: 'ocaml',
  reason: 'reason',
  nim: 'nim',
  zig: 'zig',
  v: 'vlang',
  crystal: 'crystal',
  d: 'd',
  sql: 'database',
  graphql: 'graphql',
  solidity: 'solidity',
  nasm: 'assembly',
  nix: 'nix',
  hcl: 'terraform',
  puppet: 'puppet',
  latex: 'tex',
  bibtex: 'bibliography',
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  text: 'document',
  vim: 'vim',
  makefile: 'makefile',
  cmake: 'cmake',
  diff: 'diff',
  prisma: 'prisma',
  protobuf: 'proto',
  thrift: 'document',
  wasm: 'webassembly',
  glsl: 'shader',
  hlsl: 'shader',
  cg: 'shader',
  apacheconf: 'settings',
  nginx: 'nginx',
};

const extensionIconMap: Record<string, string> = {
  yml: 'yaml',
  mdx: 'mdx',
  md: 'markdown',
  lock: 'lock',
  env: 'settings',
  zip: 'zip',
  tgz: 'zip',
  gz: 'zip',
  rar: 'zip',
  '7z': 'zip',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'svg',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'favicon',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  webm: 'video',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
};

const fallbackIconName = 'document';

const selectVariantIconName = (iconName: string, variant: ThemeVariant): string => {
  if (!iconName) {
    return variant === 'light' ? `${fallbackIconName}_light` : fallbackIconName;
  }

  if (variant === 'light') {
    const lightName = iconName.endsWith('_light') ? iconName : `${iconName}_light`;
    return FILE_TYPE_ICON_IDS.has(lightName) ? lightName : iconName;
  }

  return iconName;
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const resolveIconName = (filePath: string, extension?: string): string => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop()?.toLowerCase() || '';

  if (fileNameIconMap[fileName]) {
    return fileNameIconMap[fileName];
  }
  if (fileName.startsWith('.env')) {
    return 'settings';
  }

  const language = getLanguageFromExtension(filePath);
  if (language && languageIconMap[language]) {
    return languageIconMap[language];
  }

  const normalizedExtension = isNonEmptyString(extension)
    ? extension.toLowerCase()
    : fileName.includes('.')
      ? fileName.split('.').pop()?.toLowerCase() || ''
      : '';

  if (normalizedExtension && extensionIconMap[normalizedExtension]) {
    return extensionIconMap[normalizedExtension];
  }

  if (normalizedExtension && FILE_TYPE_ICON_IDS.has(normalizedExtension)) {
    return normalizedExtension;
  }

  return fallbackIconName;
};

export const getFileTypeIconHref = (
  filePath: string,
  options?: { extension?: string; themeVariant?: ThemeVariant }
): string => {
  const resolvedBaseIconName = resolveIconName(filePath, options?.extension);
  const baseIconName = FILE_TYPE_ICON_IDS.has(resolvedBaseIconName) ? resolvedBaseIconName : fallbackIconName;
  const iconName = selectVariantIconName(baseIconName, options?.themeVariant || 'dark');
  ensureFileTypeSymbol(iconName);
  return `#${iconName}`;
};
