import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitAuthorSummary } from '@/lib/api/types';

interface GitAuthorLineProps {
  author: GitAuthorSummary | null;
}

/**
 * Read-only commit-author indicator for the git header. The author is
 * resolved from the user's own git config (`GET /api/git/current-identity`)
 * and PiChamber never writes git config. A failed read leaves `author` null
 * and renders nothing rather than a wrong value.
 *
 * The header is a single row shared by the full-page view and the narrow
 * right-rail panel, so the text label only shows when the header container
 * is wide (`@3xl/git-header`, set on `GitUnifiedHeader`); narrower headers
 * show a user icon that exposes the same text through its tooltip.
 */
export const GitAuthorLine: React.FC<GitAuthorLineProps> = ({ author }) => {
  if (!author) {
    return null;
  }

  const name = author.userName?.trim() ?? '';
  const email = author.userEmail?.trim() ?? '';
  const configured = Boolean(name || email);
  const authorLabel = name && email ? `${name} <${email}>` : name || email;
  const summary = configured ? `Committing as ${authorLabel}` : 'No git author configured';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={summary}
          className="typography-meta flex min-w-0 shrink-0 cursor-default items-center text-muted-foreground"
        >
          <Icon name="user" className="size-4 @3xl/git-header:hidden" aria-hidden />
          <span className="hidden max-w-[12rem] truncate @3xl/git-header:inline" aria-hidden>
            {configured ? (
              <>
                {'Committing as '}
                <span className="text-foreground">{authorLabel}</span>
              </>
            ) : (
              summary
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>
        {configured
          ? `${summary}. From your git config (user.name and user.email). PiChamber never changes it.`
          : 'Set user.name and user.email in your git config to commit. PiChamber never changes it.'}
      </TooltipContent>
    </Tooltip>
  );
};
