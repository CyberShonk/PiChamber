import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

/**
 * Single top header row for the mobile/tablet workspace drawer tabs
 * (Changes / Files / Terminal / PRs / Issues).
 *
 * Identical anatomy for every tab: `h-11` (44px), `border-b border-border`,
 * `bg-background` (same as the tab content), `pl-3` (12px) so the first
 * visible element (title text, or a leading button edge) starts 12px from
 * the left edge, and `pr-2` (8px) so trailing 36px buttons end 8px from the
 * right edge.
 *
 * Slots:
 * - `leading`: optional leading control (back button, or a `flex-1` picker
 *   such as the terminal tab dropdown). Callers that render a ghost picker
 *   with internal `px-2` should wrap it in `-ml-2` so the picker's leading
 *   icon starts at 12px (`4px` button edge + `8px` internal padding).
 * - `icon`: optional icon shown before the title, matching the desktop
 *   context panel's tab icons: an icon name for surfaces, or an element
 *   such as `FileTypeIcon` for an open file.
 * - `title`: surface or content title. Strings render as
 *   `truncate typography-ui-label font-medium text-foreground`.
 * - `actions`: trailing controls. Use shared `Button variant="ghost"
 *   size="icon"` (36px, `size-9`) with a single icon size (`size-4`).
 */
export const MobileSurfaceHeader: React.FC<{
  leading?: React.ReactNode;
  icon?: IconName | React.ReactElement;
  title?: string | React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}> = ({ leading, icon, title, actions, className }) => {
  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background pl-3 pr-2',
        className,
      )}
    >
      {leading}
      {title != null ? (
        typeof title === 'string' ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {typeof icon === 'string' ? (
              <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : icon ?? null}
            <h2 className="truncate typography-ui-label font-medium text-foreground">{title}</h2>
          </div>
        ) : (
          <div className="min-w-0 flex-1">{title}</div>
        )
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
};
