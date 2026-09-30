import React, { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { getFileTypeIconHref, getFileTypeSpriteVersion, subscribeFileTypeSprite } from '@/lib/fileTypeIcons';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';

type FileTypeIconProps = {
  filePath: string;
  extension?: string;
  className?: string;
};

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({ filePath, extension, className }) => {
  const theme = useOptionalThemeSystem();
  // The sprite loads on demand; re-render once when it arrives (and only
  // then) so the <use> target exists even where the browser does not
  // re-resolve a forward reference inserted later. Re-keying remounts just
  // the <use> element instead of relying on that re-resolution.
  const spriteVersion = useSyncExternalStore(
    subscribeFileTypeSprite,
    getFileTypeSpriteVersion,
    getFileTypeSpriteVersion,
  );
  const variant = theme?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
  const iconHref = getFileTypeIconHref(filePath, { extension, themeVariant: variant });

  return (
    <svg
      className={cn('block h-4 w-4 flex-shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <use key={spriteVersion} href={iconHref} xlinkHref={iconHref} />
    </svg>
  );
};
