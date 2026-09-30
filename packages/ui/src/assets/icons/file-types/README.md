# File Type Icons Sprite

This directory keeps the source file-type SVG icons and the generated sprite used by the UI.

## Runtime behavior

- The UI resolves an icon id in `packages/ui/src/lib/fileTypeIcons.ts`.
- Valid icon ids are loaded from `packages/ui/src/lib/fileTypeIconIds.ts`.
- `packages/ui/src/components/icons/FileTypeIcon.tsx` renders the icon with `<use href="...#icon-id" />`.
- `sprite.svg` is loaded on demand as its own chunk via a dynamic `?raw` import, never statically: it is ~965 KB raw and would otherwise dominate the startup JS chunk. The first icon request records the symbol as pending and starts a single shared load (also kicked off at idle after startup); when the load resolves, pending symbols are mounted into a hidden `<defs>`. `FileTypeIcon` subscribes to the sprite readiness version (`subscribeFileTypeSprite` / `getFileTypeSpriteVersion`) and re-renders once when the sprite arrives, so icons requested before the load still resolve.

The sprite generator rewrites internal SVG ids per icon (gradients, clip paths, filters) so ids do not collide after packing all icons into one file.

## Build step

- No special step is required for normal `dev`/`build`.
- Regenerate the sprite only when icon source files in this folder change:

```bash
bun run icons:sprite
```

The command regenerates both `sprite.svg` and `packages/ui/src/lib/fileTypeIconIds.ts`.
Both generated files are committed and consumed automatically by app builds.

If you only run `bun run dev`, `bun run build`, `bun run lint`, or `bun run type-check`, no extra sprite step is needed unless the source icon files changed.
