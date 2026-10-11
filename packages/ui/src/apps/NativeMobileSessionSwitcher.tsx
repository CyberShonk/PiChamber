import React from 'react';
import { nativeHaptic } from './native/device';
import type { Session } from '@/lib/chat/types';

import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useSwitcherItems } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { filterMobileRecentSessions } from './mobileSessionSearch';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';
import { SessionUnreadDot } from '@/components/session/sidebar/SessionUnreadDot';
import { MOBILE_HEADER_POPOVER_WIDTH, useMobileHeaderOverlay } from './useMobileHeaderOverlay';

const RECENT_SESSIONS_LIMIT = 50;

const getSessionTitle = (session: Session, fallback: string): string =>
  getSessionDisplayTitle(session, fallback);

/** One switcher row: live status (busy spinner / attention dot), title,
    "project · branch", compact time. Mirrors the desktop SessionSwitcherDropdown
    indicator conventions; no subsession chevrons on mobile by design. */
const SwitcherRow: React.FC<{
  session: Session;
  meta: string;
  active: boolean;
  onSelect: () => void;
}> = ({ session, meta, active, onSelect }) => {

  const status = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = status?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = isStreaming && hasActivityDuration;
  const timeLabel = formatSessionCompactDateLabel(session.time?.updated ?? session.time?.created ?? 0);

  return (
    <button
      type="button"
      className={cn(
        'flex min-h-[44px] w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active && 'bg-interactive-selection text-interactive-selection-foreground',
      )}
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('line-clamp-2 break-words typography-ui-label text-foreground')}>
          {getSessionTitle(session, "Untitled Session")}
        </span>
        {meta ? (
          <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      {/* Activity sits on the right, before the time — no reserved left gutter. */}
      {isStreaming ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          aria-hidden
        />
      ) : showUnreadDot ? (
        <SessionUnreadDot label={"Session complete"} />
      ) : null}
      {showActivityDuration ? (
        <SessionActivityDuration
          sessionId={session.id}
          running={isStreaming}
          className="typography-micro"
        />
      ) : showUnreadDot ? null : timeLabel ? (
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{timeLabel}</span>
      ) : null}
    </button>
  );
};

/** Recent-sessions popover under the mobile header, opened by tapping the
    session title. Same visual family as the metadata/usage overlay. */
export const NativeMobileSessionSwitcher: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  onBrowseAll?: () => void;
}> = ({ open, onClose, anchorRef, onBrowseAll }) => {

  const { panelRef, wrapperRef, shouldRender, isExiting, anchorLeft, isPopover } = useMobileHeaderOverlay({
    open,
    onClose,
    anchorRef,
  });
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);

  const items = useSwitcherItems(open || shouldRender, { maxParents: RECENT_SESSIONS_LIMIT });
  const [query, setQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (!open) { setQuery(''); setSearchOpen(false); }
  }, [open]);
  React.useEffect(() => {
    if (!open || !searchOpen) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, searchOpen]);
  const filteredItems = React.useMemo(() => filterMobileRecentSessions(items, query), [items, query]);

  const handleSelect = React.useCallback((session: Session) => {
    nativeHaptic();
    void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    onClose();
  }, [onClose, setCurrentSession]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={"Open session switcher"}
        className={cn(
          'oc-native-session-switcher flex flex-col overflow-hidden rounded-[20px] border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
          isPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-switcher-out' : 'session-switcher-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(isPopover
            ? {
                top: 8,
                left: anchorLeft ?? 8,
                width: `min(${MOBILE_HEADER_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-1">
          <span className="typography-ui-label font-medium">Recent sessions</span>
          <div className="flex items-center">
          <Button variant="ghost" size="icon" className="min-h-[44px] min-w-[44px]" aria-label="Search recent sessions" aria-expanded={searchOpen} onClick={() => {
            if (searchOpen) { setQuery(''); searchRef.current?.blur(); }
            setSearchOpen((value) => !value);
          }}><Icon name="search" className="size-4" /></Button>
          <Button variant="ghost" size="icon" className="min-h-[44px] min-w-[44px]" onClick={onClose} aria-label="Close session switcher"><Icon name="close" className="size-4" /></Button>
          </div>
        </div>
        {searchOpen && <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search recent sessions"
          aria-label="Search recent sessions"
          autoCapitalize="none"
          autoCorrect="off"
          className="mb-2 h-11 shrink-0 rounded-lg border border-border bg-transparent px-3 text-[16px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setQuery(''); setSearchOpen(false); } }}
        />}
        <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
          {filteredItems.length === 0 ? (
            <p className="px-3 py-6 text-center typography-small text-muted-foreground">
              {query.trim() ? "No matching recent sessions" : "No recent sessions"}
            </p>
          ) : (
            filteredItems.map((item) => {
              const session = item.node.session;
              const meta = [item.secondaryMeta?.projectLabel, item.secondaryMeta?.branchLabel]
                .filter(Boolean)
                .join(' · ');
              return (
                <SwitcherRow
                  key={session.id}
                  session={session}
                  meta={meta}
                  active={session.id === currentSessionId}
                  onSelect={() => {
                    if (item.projectId) setActiveProjectIdOnly(item.projectId);
                    handleSelect(session);
                  }}
                />
              );
            })
          )}
        </div>
        {onBrowseAll ? (
          <Button variant="ghost" size="lg" className="mt-1 w-full shrink-0" onClick={() => { onClose(); onBrowseAll(); }}>Browse all sessions</Button>
        ) : null}
      </div>
      <style>{`
        @keyframes session-switcher-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-switcher-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};
