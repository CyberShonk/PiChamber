import type { ExtensionWidgetEntry } from '@/components/chat/extension/ExtensionWidgetsContent';
import { stripAnsi } from '@/lib/pi/ansi';
import type { LiveSessionRecord } from '@/sync/pi-session-catalog';
import type { PiReducerSessionState } from '@/lib/pi/reducers/reducerTypes';
export type CompanionTab = 'sessions' | 'review' | 'artifacts' | 'extensions' | 'attention';
export type CompanionAction = {
    scope: number;
    type: 'tab' | 'session' | 'file' | 'preview' | 'refresh' | 'scope' | 'answer' | 'question' | 'widget';
    index?: number;
    choice?: number;
    tab?: CompanionTab;
};
export type CompanionView = {
    tab: CompanionTab;
    projectOnly?: boolean;
    workspace: string;
    connected: boolean;
    selectedSession: string;
    sessions: Array<{
        title: string;
        project: string;
        state: string;
        selected: boolean;
        unseen?: number;
    }>;
    files: Array<{
        name: string;
        parent: string;
        staged: boolean;
        added: number;
        removed: number;
    }>;
    selectedFile: number | null;
    preview: {
        kind: 'diff' | 'text' | 'image' | 'notice';
        content: string;
        title: string;
    } | null;
    loading: boolean;
    error: string | null;
    widgets?: ExtensionWidgetEntry[];
    collapsedWidgets?: Record<string, boolean>;
    questions: Array<{
        title: string;
        message: string;
        session: string;
        method: string;
        options: string[];
    }>;
};
const tabs: CompanionTab[] = ['sessions', 'review', 'artifacts', 'extensions', 'attention'];
export const allowedCompanionAction = (action: CompanionAction) => {
    if (!Number.isSafeInteger(action.scope))
        return false;
    if (action.type === 'tab')
        return tabs.includes(action.tab!);
    if (action.type === 'refresh' || action.type === 'scope')
        return true;
    if (!['session', 'file', 'preview', 'answer', 'question', 'widget'].includes(action.type))
        return false;
    return Number.isInteger(action.index) && action.index! >= 0 && action.index! < 50 && (action.type !== 'answer' || (Number.isInteger(action.choice) && action.choice! >= 0 && action.choice! < 32));
};
export const sessionBoard = (records: Iterable<LiveSessionRecord>, selected: string | null, connected: boolean, directory?: string) => Array.from(records)
    .filter((record) => !record.archived && (!directory || record.directory === directory || record.directory.startsWith(directory + '/'))).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, 50)
    .map((record) => ({ id: record.id, directory: record.directory, title: record.title.slice(0, 240) || 'Untitled session', project: record.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? '', state: connected ? record.lifecycle : 'offline', selected: record.id === selected }));
/** Read only actual pending extension dialogs, never infer questions from text. */
export const attentionItems = (sessions: Map<string, PiReducerSessionState>, titles: ReadonlyMap<string, LiveSessionRecord>) => {
    const items: Array<{
        sessionId: string;
        request: PiReducerSessionState['extensionDialogs'][number];
        title: string;
        message: string;
        session: string;
        method: string;
        options: string[];
    }> = [];
    for (const [sessionId, state] of sessions) {
        for (const request of state.extensionDialogs) {
            const title = stripAnsi(request.title);
            const message = stripAnsi(request.message ?? '');
            const options = request.options ?? [];
            const complete = title.length <= 300 && message.length <= 2000 && options.length <= 32 && options.every((option) => option.length <= 240);
            items.push({ sessionId, request, title: title.slice(0, 300), message: message.slice(0, 2000), session: titles.get(sessionId)?.title.slice(0, 240) ?? 'Session', method: request.method, options: !complete ? [] : request.method === 'confirm' ? ['Confirm', 'Cancel'] : request.method === 'select' ? options : [] });
            if (items.length === 20)
                return items;
        }
    }
    return items;
};
export const safeCompanionImage = (value: string) => value.length <= 2000000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
export const boundedCompanionText = (content: string) => {
    const prefix = content.slice(0, 120000);
    const lines = prefix.split('\n');
    const text = lines.slice(0, 2000).join('\n');
    return text + (content.length > 120000 || lines.length > 2000 ? '\n… Preview truncated. Open the full file on the top screen.' : '');
};
/** Bound secondary display content without exposing transcript or status streams. */
export const companionWidgets = (widgets: Map<string, {
    lines: string[];
    placement: 'aboveEditor' | 'belowEditor';
}> | undefined): ExtensionWidgetEntry[] => {
    let remaining = 100000;
    const entries: ExtensionWidgetEntry[] = [];
    for (const [key, widget] of Array.from(widgets ?? []).slice(0, 30)) {
        if (remaining <= 0)
            break;
        const limit = Math.min(16000, remaining);
        const prefix = widget.lines.slice(0, 200).join('\n').slice(0, limit);
        remaining -= prefix.length;
        const truncated = widget.lines.length > 200 || widget.lines.slice(0, 200).join('\n').length > limit;
        entries.push([key, { placement: widget.placement, lines: prefix.split('\n').concat(truncated ? ['… Widget truncated. Open Extensions on the top screen.'] : []) }]);
    }
    return entries;
};
