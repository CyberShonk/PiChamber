import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useCopyFeedback } from './useCopyFeedback';
import {
  SettingsControlGroup,
  SETTINGS_GROUP_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';
import type { TailscaleTone } from './tailscaleViewModel';

const PILL_TONE_CLASS: Record<TailscaleTone, string> = {
  neutral: 'text-muted-foreground bg-muted border-border/50',
  success: 'text-[var(--status-success)] bg-[var(--status-success)]/10 border-[var(--status-success)]/30',
  warning: 'text-[var(--status-warning)] bg-[var(--status-warning)]/10 border-[var(--status-warning)]/30',
  error: 'text-[var(--status-error)] bg-[var(--status-error-background)] border-[var(--status-error-border)]',
  info: 'text-[var(--status-info)] bg-[var(--status-info-background)] border-[var(--status-info-border)]',
};

/** Small status pill for route rows. Tones are status semantics only. */
export const RouteStatusPill: React.FC<{ tone: TailscaleTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span
    className={cn(
      'typography-micro shrink-0 rounded border px-1.5 py-px leading-relaxed',
      PILL_TONE_CLASS[tone],
    )}
  >
    {children}
  </span>
);

/** One "Ways to connect" route row: icon + title + pill, description, control. */
export const RouteRow: React.FC<{
  id?: string;
  icon: IconName;
  title: React.ReactNode;
  pill?: React.ReactNode;
  description: React.ReactNode;
  settingsItem?: string;
  children: React.ReactNode;
}> = ({ id, icon, title, pill, description, settingsItem, children }) => (
  <SettingsControlGroup
    settingsItem={settingsItem}
    title={(
      <span className="flex min-w-0 flex-wrap items-center gap-2" id={id}>
        <Icon name={icon} className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={SETTINGS_GROUP_TITLE_CLASS}>{title}</span>
        {pill}
      </span>
    )}
  >
    <div className="space-y-2">
      <p className="typography-meta text-muted-foreground">{description}</p>
      {children}
    </div>
  </SettingsControlGroup>
);

/** Click-to-copy address field. Without `onOpen` the whole field is one button; with `onOpen` the bordered container holds a copy button plus an in-field open button. */
export const RouteAddress: React.FC<{
  url: string;
  copyLabel: string;
  onOpen?: () => void;
  openLabel?: string;
}> = ({ url, copyLabel, onOpen, openLabel }) => {
  const { copied, copy } = useCopyFeedback();
  const ariaLabel = copied ? `${copyLabel} (copied)` : copyLabel;
  const addressBody = (
    <>
      <code className="min-w-0 flex-1 truncate font-mono typography-micro text-foreground">{url}</code>
      <span className="flex shrink-0 items-center gap-1">
        {copied ? (
          <span className="typography-micro text-[var(--status-success)]">Copied</span>
        ) : null}
        <Icon
          name={copied ? 'check' : 'file-copy'}
          className={cn('h-3.5 w-3.5', copied ? 'text-[var(--status-success)]' : 'text-muted-foreground')}
          aria-hidden
        />
      </span>
      {copied ? <span className="sr-only" role="status">Copied</span> : null}
    </>
  );

  if (!onOpen) {
    return (
      <button
        type="button"
        onClick={() => copy(url)}
        aria-label={ariaLabel}
        title={url}
        className="flex min-w-0 max-w-[24rem] items-center gap-1.5 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)] px-2 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {addressBody}
      </button>
    );
  }

  return (
    <div className="flex min-w-0 max-w-[24rem] items-center gap-0.5 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-muted)] py-1 pl-2 pr-1">
      <button
        type="button"
        onClick={() => copy(url)}
        aria-label={ariaLabel}
        title={url}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {addressBody}
      </button>
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel ?? 'Open address'}
        title={openLabel ?? undefined}
        className="flex shrink-0 items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Icon name="external-link" className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
};
