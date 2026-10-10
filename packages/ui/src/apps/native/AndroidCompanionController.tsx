import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMobileAppActions } from '../mobileAppContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useNotificationStore } from '@/sync/notification-store';
import { useGitStore } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot, usePiSessionStore } from '@/sync/pi-session-context';
import { piClient, PiRequestError } from '@/lib/pi/client';
import { getClientPlatform } from '@/lib/platform';
import { toast } from '@/components/ui';
import { useNativePreferences } from './preferences';
import type { PluginListenerHandle } from '@capacitor/core';
import { AndroidCompanion, startCompanion, type CompanionState } from './androidCompanion';
import { createCompanionRoutes } from './companionRoutes';
import { companionFrame, type CompanionFrame } from './companionDocument';
import { CompanionSurface } from './CompanionSurface';
import { attentionItems, companionWidgets, boundedCompanionText, safeCompanionImage, sessionBoard, type CompanionAction, type CompanionTab, type CompanionView } from './companionModel';
import { nativeHaptic } from './device';
let nextScope = 0;
const subscribeRuntime = (callback: () => void) => subscribeRuntimeEndpointChanged(callback);
const imagePath = (path: string) => /\.(png|jpe?g|webp|gif)$/i.test(path);
const EnabledCompanion = () => {
    const actions = useMobileAppActions();
    const apis = useRuntimeAPIs();
    const store = usePiSessionStore();
    const directory = useEffectiveDirectory() ?? '';
    const runtimeKey = useSyncExternalStore(subscribeRuntime, getRuntimeKey, getRuntimeKey);
    const { currentTheme } = useThemeSystem();
    const sessionId = useSessionUIStore((state) => state.currentSessionId);
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const catalog = usePiSessionSnapshot((state) => state.catalog.byId, Object.is, 'catalog');
    const connected = usePiSessionSnapshot((state) => state.connection === 'ready' && state.syncReadiness === 'ready', Object.is, 'chrome');
    const questions = usePiSessionSnapshot((state) => attentionItems(state.reducer.bySession, state.catalog.byId), (a, b) => a.length === b.length && a.every((item, index) => item.sessionId === b[index].sessionId && item.request === b[index].request), 'dialogs');
    const gitStatus = useGitStore((state) => state.runtimeKey === runtimeKey ? state.directories.get(directory)?.status ?? null : null);
    const unseen = useNotificationStore((state) => state.index.session.unseenCount);
    const [projectOnly, setProjectOnly] = useState(false);
    const sessions = useMemo(() => sessionBoard(catalog.values(), sessionId, connected, projectOnly ? directory : undefined).map((item) => ({ ...item, unseen: unseen[item.id] ?? 0 })), [catalog, sessionId, connected, projectOnly, directory, unseen]);
    const files = useMemo(() => (gitStatus?.files ?? []).slice(0, 50).map((file) => {
        const split = file.path.split(/[\\/]/);
        const name = split.pop() ?? file.path;
        const stats = gitStatus?.diffStats?.[file.path];
        return { path: file.path, name: name.slice(-160), parent: split.join('/').slice(-180), staged: Boolean(file.index.trim() && file.index.trim() !== '?' && !file.working_dir.trim()), added: stats?.insertions ?? 0, removed: stats?.deletions ?? 0 };
    }), [gitStatus]);
    const owner = useMemo(() => ({ id: ++nextScope, runtimeKey, directory, sessionId }), [runtimeKey, directory, sessionId]);
    const [tab, setTab] = useState<CompanionTab>('review');
    const widgetMap = usePiSessionSnapshot((state) => tab === 'extensions' && sessionId ? state.reducer.bySession.get(sessionId)?.extensionWidgets : undefined, Object.is, sessionId ? `session:${sessionId}` : 'chrome');
    const widgets = useMemo(() => companionWidgets(widgetMap), [widgetMap]);
    const [collapsedWidgets, setCollapsedWidgets] = useState<Record<string, boolean>>({});
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [previewState, setPreviewState] = useState<{
        owner: number;
        key: string;
        preview: CompanionView['preview'];
        loading: boolean;
        error: string | null;
    } | null>(null);
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        if (connected && directory && runtimeKey === getRuntimeKey() && (tab === 'review' || tab === 'artifacts')) {
            void useGitStore.getState().ensureStatus(directory, apis.git);
        }
    }, [connected, directory, runtimeKey, tab, apis, refresh]);
    const [answerBusy, setAnswerBusy] = useState(false);
    const [answerError, setAnswerError] = useState<string | null>(null);
    const selectedFile = files.findIndex((file) => file.path === selectedPath);
    const file = selectedFile >= 0 ? files[selectedFile] : null;
    const readPath = file?.path;
    const readName = file?.name;
    const readStaged = file?.staged;
    const selectedRead = useMemo(() => readPath && readName ? { path: readPath, name: readName, staged: readStaged ?? false } : null, [readPath, readName, readStaged]);
    const previewKey = `${tab}:${file?.path ?? ''}:${file?.staged ?? false}`;
    useEffect(() => {
        if (!selectedRead || !connected || (tab !== 'review' && tab !== 'artifacts'))
            return;
        let disposed = false;
        const activeFile = selectedRead;
        const update = (preview: CompanionView['preview'], error: string | null, loading = false) => { if (!disposed && owner.runtimeKey === getRuntimeKey())
            setPreviewState({ owner: owner.id, key: previewKey, preview, error, loading }); };
        update(null, null, true);
        void (async () => {
            try {
                if (tab === 'review') {
                    const diff = await apis.git.getGitDiff(owner.directory, { path: activeFile.path, staged: activeFile.staged, contextLines: 3 });
                    const content = diff.diff;
                    update({ kind: content ? 'diff' : 'notice', title: activeFile.name, content: content ? boundedCompanionText(content) : 'No textual diff is available for this file.' }, null);
                }
                else {
                    const path = `${owner.directory.replace(/\/$/, '')}/${activeFile.path}`;
                    if (!apis.files.statFile)
                        throw new Error('unsupported');
                    const stat = await apis.files.statFile(path, { directory: owner.directory });
                    if (!stat.isFile || stat.size > 1400000) {
                        update({ kind: 'notice', title: activeFile.name, content: 'This file is too large for the companion preview. Open Files on the top screen.' }, null);
                        return;
                    }
                    if (imagePath(path) && apis.files.readFileBinary) {
                        const result = await apis.files.readFileBinary(path, { directory: owner.directory });
                        if (!safeCompanionImage(result.dataUrl))
                            throw new Error('unsupported');
                        update({ kind: 'image', title: activeFile.name, content: result.dataUrl }, null);
                    }
                    else if (apis.files.readFile && /\.(txt|md|json|ya?ml|toml|ini|log|csv|ts|tsx|js|jsx|java|kt|swift|py|c|cpp|h|css|html|sh|xml)$/i.test(path)) {
                        const result = await apis.files.readFile(path, { directory: owner.directory });
                        if (result.exists === false)
                            throw new Error('missing');
                        update({ kind: 'text', title: activeFile.name, content: boundedCompanionText(result.content) }, null);
                    }
                    else
                        update({ kind: 'notice', title: activeFile.name, content: 'No companion preview is available for this file. Open Files on the top screen.' }, null);
                }
            }
            catch {
                update(null, 'Preview could not be loaded. Tap Refresh to retry.');
            }
        })();
        return () => { disposed = true; };
        // File-content reads are explicit: selection or Refresh, never Git/token polling.
    }, [apis, owner, previewKey, refresh, connected, selectedRead, tab]);
    const currentPreview = connected && previewState?.owner === owner.id && previewState.key === previewKey ? previewState : null;
    const view = useMemo<CompanionView>(() => ({ tab, widgets, collapsedWidgets, projectOnly, workspace: directory.split(/[\\/]/).filter(Boolean).at(-1) ?? '', connected, selectedSession: catalog.get(sessionId ?? '')?.title.slice(0, 160) ?? '', sessions, files, selectedFile: selectedFile >= 0 ? selectedFile : null, preview: currentPreview?.preview ?? null, loading: currentPreview?.loading || answerBusy, error: currentPreview?.error || answerError, questions }), [tab, widgets, collapsedWidgets, projectOnly, directory, connected, catalog, sessionId, sessions, files, selectedFile, currentPreview, answerBusy, answerError, questions]);
    const surface = useRef<HTMLDivElement>(null);
    const frame = useRef<CompanionFrame | null>(null);
    const session = useRef<ReturnType<typeof startCompanion> | null>(null);
    const latest = useRef({ owner, sessions, files, widgets, questions, connected, apis, actions, store, setCurrentSession });
    const routes = useRef(createCompanionRoutes<{
        owner: typeof owner;
        sessions: typeof sessions;
        files: typeof files;
        widgets: typeof widgets;
        questions: typeof questions;
    }>());
    useLayoutEffect(() => {
        latest.current = { owner, sessions, files, widgets, questions, connected, apis, actions, store, setCurrentSession };
        if (!surface.current) return;
        // Serialize committed client DOM. Importing React's server renderer here
        // creates a vendor initialization cycle in the packaged mobile build.
        const nextFrame = companionFrame(surface.current.innerHTML, currentTheme, ++nextScope, owner.id,
            Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((link) => link.href));
        frame.current = nextFrame;
        routes.current.remember(nextFrame.scope, { owner, sessions, files, widgets, questions });
        session.current?.update(nextFrame);
    }, [view, currentTheme, owner, sessions, files, widgets, questions, connected, apis, actions, store, setCurrentSession]);
    const answerFlight = useRef(false);
    useEffect(() => {
        let disposed = false;
        const onAction = (action: CompanionAction) => {
            const current = latest.current;
            const shown = routes.current.resolve(action.scope, current.owner.id);
            if (disposed || !shown || current.owner.runtimeKey !== getRuntimeKey() || document.visibilityState === 'hidden' || document.documentElement.classList.contains('oc-keyboard-open'))
                return;
            if (action.type === 'tab') {
                setTab(action.tab!);
                setAnswerError(null);
                return;
            }
            if (action.type === 'scope') {
                setProjectOnly((value) => !value);
                return;
            }
            if (action.type === 'widget') {
                const widget = shown.widgets[action.index!];
                if (widget)
                    setCollapsedWidgets((previous) => ({ ...previous, [widget[0]]: !previous[widget[0]] }));
                return;
            }
            if (action.type === 'refresh') {
                setRefresh((value) => value + 1);
                setAnswerError(null);
                return;
            }
            if (!current.connected)
                return;
            nativeHaptic();
            if (action.type === 'session') {
                const target = shown.sessions[action.index!];
                if (target) {
                    current.actions?.closeDrawers?.();
                    void current.setCurrentSession(target.id, target.directory);
                }
            }
            else if (action.type === 'file' || action.type === 'preview') {
                const target = shown.files[action.index!];
                if (target)
                    setSelectedPath(target.path);
            }
            else if (action.type === 'question') {
                const target = shown.questions[action.index!];
                const record = target && current.store.getState().catalog.byId.get(target.sessionId);
                if (target && record) {
                    current.actions?.closeDrawers?.();
                    void current.setCurrentSession(target.sessionId, record.directory);
                }
            }
            else if (action.type === 'answer' && !answerFlight.current) {
                const target = shown.questions[action.index!];
                if (!target || action.choice! >= target.options.length || !current.store.getState().reducer.bySession.get(target.sessionId)?.extensionDialogs.some((request) => request.requestId === target.request.requestId && request === target.request))
                    return;
                const value = target.request.method === 'select' ? target.request.options?.[action.choice!] : undefined;
                if (target.request.method !== 'confirm' && value === undefined)
                    return;
                if (target.request.method === 'confirm' && action.choice! > 1)
                    return;
                answerFlight.current = true;
                setAnswerBusy(true);
                setAnswerError(null);
                const runtime = current.owner.runtimeKey;
                void piClient.respondToExtensionDialog({ requestId: target.request.requestId, ...(target.request.method === 'confirm' ? { confirmed: action.choice === 0 } : { value }) }, { runtimeKey: runtime }).then(() => {
                    if (getRuntimeKey() === runtime)
                        current.store.dismissExtensionDialog(target.sessionId, target.request.requestId);
                }).catch((error: unknown) => {
                    if (disposed || getRuntimeKey() !== runtime)
                        return;
                    if (error instanceof PiRequestError && error.code === 'EXTENSION_DIALOG_NOT_PENDING')
                        current.store.dismissExtensionDialog(target.sessionId, target.request.requestId);
                    else if (latest.current.owner.id === current.owner.id)
                        setAnswerError('The answer was not sent. Check the host connection and retry.');
                }).finally(() => { answerFlight.current = false; if (!disposed)
                    setAnswerBusy(false); });
            }
        };
        const navigate = (event: Event) => {
            const tab = (event as CustomEvent<{
                tab?: CompanionTab;
            }>).detail?.tab;
            if (!disposed && latest.current.owner.runtimeKey === getRuntimeKey() && (tab === 'review' || tab === 'artifacts' || tab === 'extensions')) {
                setTab(tab);
                setAnswerError(null);
            }
        };
        let stateListener: PluginListenerHandle | undefined;
        const stateChanged = (state: CompanionState) => { if (!disposed)
            document.documentElement.dataset.androidCompanionState = state.status; };
        void (async () => {
            try {
                stateListener = await AndroidCompanion.addListener('state', stateChanged);
                if (disposed) {
                    await stateListener.remove();
                    return;
                }
                stateChanged(await AndroidCompanion.getState());
            }
            catch {
                if (!disposed)
                    delete document.documentElement.dataset.androidCompanionState;
            }
        })();
        window.addEventListener('oc:companion-workspace', navigate);
        let reported = false;
        const owner = startCompanion(onAction, () => { if (!reported)
            toast.error('The companion could not be updated. Retry in Appearance settings.'); reported = true; }, document.documentElement.classList.contains('oc-keyboard-open'));
        session.current = owner;
        if (frame.current) owner.update(frame.current);
        const keyboard = (event: Event) => { const open = (event as CustomEvent<{
            open?: boolean;
        }>).detail?.open; if (typeof open === 'boolean')
            owner.keyboard(open); };
        window.addEventListener('oc:keyboard-settled', keyboard);
        window.addEventListener('oc:keyboard-intent', keyboard);
        return () => { disposed = true; window.removeEventListener('oc:companion-workspace', navigate); delete document.documentElement.dataset.androidCompanionState; void stateListener?.remove(); session.current = null; window.removeEventListener('oc:keyboard-settled', keyboard); window.removeEventListener('oc:keyboard-intent', keyboard); owner.dispose(); };
    }, []);
    return <div ref={surface} hidden aria-hidden="true"><CompanionSurface view={view} /></div>;
};
export const AndroidCompanionController = () => {
    const { dualScreen } = useNativePreferences();
    return getClientPlatform() === 'android' && dualScreen ? <EnabledCompanion /> : null;
};
