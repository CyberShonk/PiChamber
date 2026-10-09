import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useMobileAppActions } from '../mobileAppContext';
import { useSwitcherItems } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { filterMobileRecentSessions } from '../mobileSessionSearch';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { useNotificationStore } from '@/sync/notification-store';
import { useUIStore } from '@/stores/useUIStore';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { exportMobileErrorLog } from '@/lib/mobile-error-log';
import { saveOrShareFile } from '@/lib/nativeFileSave';
import { useNativeAttentionEvents } from './attention';
import { nativeHaptic } from './device';
import { useNativePreferences } from './preferences';
import { saveOfflineCopy } from './offlineCopies';
import { formatTranscript, transcriptEntries } from './transcript';

export const NativeQuickNavigation: React.FC<{ onClose: () => void; onWorkspace: (tab: 'terminal' | 'context' | 'extensions') => void; onOffline: () => void }> = ({ onClose, onWorkspace, onOffline }) => {
  const actions = useMobileAppActions();
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const select = useSessionUIStore((state) => state.setCurrentSession);
  const items = useSwitcherItems(true, { maxParents: 50 });
  const notifications = useNotificationStore((state) => state.list);
  const records = useSessionMessageRecords(sessionId ?? '');
  const entries = React.useMemo(() => transcriptEntries(records), [records]);
  const searchIndex = React.useMemo(() => entries.map((entry) => ({
    entry,
    text: `${entry.text} ${entry.tools.map((tool) => `${tool.name} ${tool.command ?? ''} ${tool.output ?? ''}`).join(' ')}`.toLocaleLowerCase(),
  })), [entries]);
  const [query, setQuery] = React.useState('');
  const [view, setView] = React.useState<'sessions' | 'attention' | 'transcript'>('sessions');
  const [kind, setKind] = React.useState<'all' | 'user' | 'error' | 'tools'>('all');
  const preferences = useNativePreferences();
  const recordedEvents = useNativeAttentionEvents();
  const deferredQuery = React.useDeferredValue(query);
  const recordedSessions = React.useMemo(() => new Set(recordedEvents.filter((event) => event.runtimeKey === getRuntimeKey()).map((event) => event.session)), [recordedEvents]);
  const current = items.find((item) => item.node.session.id === sessionId);
  const title = getSessionDisplayTitle(current?.node.session, 'Session');
  const matching = React.useMemo(() => filterMobileRecentSessions(items, deferredQuery), [items, deferredQuery]);
  const unseen = React.useMemo(() => new Set(notifications.filter((item) => !item.viewed && item.session && recordedEvents.some((event) => event.runtimeKey === getRuntimeKey() && event.session === item.session && event.time === item.time && event.type === item.type)).map((item) => item.session!)), [notifications, recordedEvents]);
  const matchingEntries = React.useMemo(() => searchIndex.filter(({ entry, text }) => (kind === 'all' || (kind === 'user' ? entry.role === 'user' : kind === 'error' ? entry.error : entry.tools.length > 0)) && text.includes(deferredQuery.toLocaleLowerCase())).slice(-100).map(({ entry }) => entry), [searchIndex, kind, deferredQuery]);
  const run = async (task: () => Promise<unknown>) => { try { await task(); } catch { nativeHaptic('error'); toast.error('The action could not be completed. Check device permissions and storage.'); } };
  const copy = (text: string) => void run(async () => { await navigator.clipboard.writeText(text); nativeHaptic('success'); toast.success('Copied'); });
  const open = (task: () => void) => { onClose(); nativeHaptic(); task(); };
  return <div className="min-h-0 flex-1 overflow-auto p-4" data-no-drawer-swipe="true">
    <p className="mb-3 truncate typography-meta text-muted-foreground">{actions?.instanceLabel ?? 'Connected host'}{current?.secondaryMeta?.projectLabel ? ` · ${current.secondaryMeta.projectLabel}` : ''}{current?.secondaryMeta?.branchLabel ? ` · ${current.secondaryMeta.branchLabel}` : ''}</p>
    <input type="search" placeholder={view === 'transcript' ? 'Search loaded messages and tool output' : 'Search sessions, projects and branches'} aria-label="Search quick navigation" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} className="mb-3 h-11 w-full rounded-md border border-border bg-transparent px-3 text-[16px]" />
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Navigation results">
      {(['sessions', 'attention', 'transcript'] as const).map((value) => <Button key={value} size="sm" variant={view === value ? 'secondary' : 'ghost'} aria-pressed={view === value} onClick={() => { setView(value); setQuery(''); }}>{value === 'sessions' ? 'Sessions' : value === 'attention' ? 'Needs attention' : 'Transcript'}</Button>)}
    </div>
    <div className="mb-4 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => open(() => actions?.openFiles())}>Files</Button>
      <Button size="sm" variant="outline" onClick={() => open(() => actions?.openChanges())}>Changes</Button>
      {(['terminal', 'context', 'extensions'] as const).map((tab) => <Button key={tab} size="sm" variant="outline" onClick={() => open(() => onWorkspace(tab))}>{tab === 'terminal' ? 'Terminal' : tab === 'context' ? 'Context' : 'Extensions'}</Button>)}
      <Button size="sm" variant="outline" onClick={() => open(() => { useUIStore.getState().setTimelineDialogOpen(true); })}>Timeline</Button>
      <Button size="sm" variant="outline" onClick={() => open(() => actions?.openInstances?.())}>Hosts</Button>
      <Button size="sm" variant="outline" onClick={() => open(() => actions?.openSettings('appearance'))}>Appearance</Button>
    </div>
    {view === 'transcript' ? <>
      <p className="mb-2 typography-meta text-muted-foreground">Loaded messages only. Use Timeline to load and navigate older history.</p>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Transcript filters">{(['all', 'user', 'error', 'tools'] as const).map((value) => <Button key={value} size="sm" variant={kind === value ? 'secondary' : 'ghost'} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'all' ? 'All' : value === 'user' ? 'Your messages' : value === 'error' ? 'Errors' : 'Tools'}</Button>)}</div>
      {matchingEntries.length === 0 && <p className="py-4 typography-small text-muted-foreground">No matching loaded messages.</p>}
      {matchingEntries.map((entry) => <div key={entry.id} className="border-b border-border py-3">
        <div className="mb-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => open(() => { window.location.hash = `message-${entry.id}`; })}>Jump to {entry.role}</Button>{entry.text && <Button size="sm" variant="ghost" onClick={() => copy(entry.text)}>Copy message</Button>}</div>
        <p className="line-clamp-3 whitespace-pre-wrap break-words typography-small">{entry.text || (entry.error ? 'Error in this message' : 'Tool activity')}</p>
        {entry.tools.map((tool, index) => <div key={index} className="mt-2 flex flex-wrap items-center gap-2"><span className="typography-meta text-muted-foreground">{tool.name}</span>{tool.command && <Button size="sm" variant="ghost" onClick={() => copy(tool.command!)}>Copy command</Button>}{tool.output && <Button size="sm" variant="ghost" onClick={() => copy(tool.output!)}>Copy output</Button>}</div>)}
      </div>)}
    </> : <>
      {view === 'attention' && <p className="mb-2 typography-meta text-muted-foreground">Unread completions and errors observed on this host.</p>}
      {matching.filter((item) => view !== 'attention' || (unseen.has(item.node.session.id) && recordedSessions.has(item.node.session.id))).map((item) => <button type="button" key={item.node.session.id} className="flex min-h-14 w-full flex-col border-b border-border py-3 text-left" aria-current={sessionId === item.node.session.id ? 'true' : undefined} onClick={() => { onClose(); nativeHaptic(); void select(item.node.session.id, resolveGlobalSessionDirectory(item.node.session)); }}>
        <span className="line-clamp-2 typography-ui-label">{getSessionDisplayTitle(item.node.session, 'Untitled session')}</span>
        <span className="typography-meta text-muted-foreground">{[item.secondaryMeta?.projectLabel, item.secondaryMeta?.branchLabel].filter(Boolean).join(' · ')}{(unseen.has(item.node.session.id) && recordedSessions.has(item.node.session.id)) ? ' · Unread activity' : ''}</span>
      </button>)}
      {matching.every((item) => view === 'attention' && !(unseen.has(item.node.session.id) && recordedSessions.has(item.node.session.id))) && <p className="py-4 typography-small text-muted-foreground">{view === 'attention' ? 'No matching sessions need attention.' : 'No matching recent sessions.'}</p>}
    </>}
    <div className="mt-5 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!sessionId || entries.length === 0} onClick={() => void run(() => saveOrShareFile({ filename: 'pichamber-loaded-transcript.md', mimeType: 'text/markdown', data: `# ${title}\n\nLoaded transcript exported ${new Date().toLocaleString()}. Older unloaded messages are not included.\n\n${formatTranscript(entries)}` }))}>Share loaded transcript</Button>
      {preferences.offlineCache && <Button size="sm" variant="outline" disabled={!sessionId || entries.length === 0} onClick={() => void run(async () => { const runtimeKey = getRuntimeKey(); await saveOfflineCopy({ id: JSON.stringify([runtimeKey, sessionId]), runtimeKey, sessionId: sessionId!, title, host: actions?.instanceLabel ?? 'Host', savedAt: Date.now(), text: formatTranscript(entries.slice(-200)) }); toast.success('Offline copy saved. Includes up to 200 loaded messages.'); })}>Save offline copy</Button>}
      <Button size="sm" variant="outline" onClick={onOffline}>Offline copies</Button>
      <Button size="sm" variant="outline" onClick={() => void run(exportMobileErrorLog)}>Share redacted diagnostics</Button>
    </div>
  </div>;
};
