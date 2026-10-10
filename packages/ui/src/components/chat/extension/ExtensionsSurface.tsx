import * as React from 'react';

import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { ExtensionWidgetsContent } from './ExtensionWidgetsContent';

export interface ExtensionsSurfaceProps {
  sessionId?: string | null;
  className?: string;
}

export const ExtensionsSurface: React.FC<ExtensionsSurfaceProps> = ({ sessionId, className }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  // Pi-native `ctx.ui.setWidget` content only. Statuses belong to the composer
  // strip; PiChamber-only panels/apps are intentionally not rendered here yet.
  // The reducer replaces the widget map copy-on-write, so reference equality
  // is exact and stays cheap while unrelated session state streams.
  const widgetMap = usePiSessionSnapshot(
    (state) => (activeSessionId ? state.reducer.bySession.get(activeSessionId)?.extensionWidgets : undefined),
    (a, b) => a === b,
    activeSessionId ? `session:${activeSessionId}` : 'chrome',
  );
  const widgets = React.useMemo(() => [...(widgetMap?.entries() ?? [])], [widgetMap]);

  const [collapsedWidgets, setCollapsedWidgets] = React.useState<Record<string, boolean>>({});

  const toggleWidget = React.useCallback((key: string) => {
    setCollapsedWidgets((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return <ExtensionWidgetsContent widgets={widgets} collapsedWidgets={collapsedWidgets} onToggle={toggleWidget} className={className} />;
};
