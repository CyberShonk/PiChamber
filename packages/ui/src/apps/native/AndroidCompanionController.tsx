import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useMobileAppActions } from '../mobileAppContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useGitStore } from '@/stores/useGitStore';
import { getClientPlatform } from '@/lib/platform';
import { toast } from '@/components/ui';
import { useNativePreferences } from './preferences';
import { companionGitSummary, startCompanion, type CompanionSnapshot } from './androidCompanion';

let nextScope = 0;
const subscribeRuntime = (callback: () => void) => subscribeRuntimeEndpointChanged(callback);

const EnabledCompanion = () => {
  const actions = useMobileAppActions();
  const directory = useEffectiveDirectory() ?? '';
  const runtimeKey = useSyncExternalStore(subscribeRuntime, getRuntimeKey, getRuntimeKey);
  const gitStatus = useGitStore((state) => state.runtimeKey === runtimeKey ? state.directories.get(directory)?.status ?? null : null);
  const isGitRepo = useGitStore((state) => state.runtimeKey === runtimeKey ? state.directories.get(directory)?.isGitRepo ?? null : null);
  const { currentTheme } = useThemeSystem();
  const scope = useMemo(() => ({ id: ++nextScope, runtimeKey, directory }), [runtimeKey, directory]);
  const snapshot = useMemo<CompanionSnapshot>(() => {
    const colors = currentTheme.colors;
    return {
      scope: ++nextScope,
      workspaceScope: scope.id,
      workspace: scope.directory.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 240) ?? 'Choose a workspace on the main screen',
      ...companionGitSummary(gitStatus, isGitRepo),
      colors: {
        background: colors.surface.background, foreground: colors.surface.foreground,
        muted: colors.surface.mutedForeground, border: colors.interactive.border,
        selection: colors.interactive.selection, selectionForeground: colors.interactive.selectionForeground,
      },
    };
  }, [scope, gitStatus, isGitRepo, currentTheme]);
  const latest = useRef({ actions, snapshot, scope });
  useLayoutEffect(() => { latest.current = { actions, snapshot, scope }; }, [actions, snapshot, scope]);
  const session = useRef<ReturnType<typeof startCompanion> | null>(null);
  useEffect(() => {
    let reported = false;
    const owner = startCompanion((action) => {
      const current = latest.current;
      if (action.scope !== current.snapshot.scope || current.scope.runtimeKey !== getRuntimeKey()) return;
      if (document.visibilityState === 'hidden' || document.documentElement.classList.contains('oc-keyboard-open')) return;
      if (action.type === 'files') current.actions?.openFiles();
      else if (action.type === 'changes') current.actions?.openChanges();
      else if (action.type === 'settings') current.actions?.openSettings('appearance');
      else if (action.type === 'file' && Number.isInteger(action.index)) {
        const file = current.snapshot.files[action.index!];
        if (file) current.actions?.openChanges({ diffPath: file.path, staged: file.staged });
      }
    }, () => {
      if (!reported) toast.error('The second-screen companion could not be updated. Retry in Appearance settings.');
      reported = true;
    }, document.documentElement.classList.contains('oc-keyboard-open'));
    session.current = owner;
    const onKeyboard = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      if (typeof detail?.open === 'boolean') owner.keyboard(detail.open);
    };
    owner.keyboard(document.documentElement.classList.contains('oc-keyboard-open'));
    window.addEventListener('oc:keyboard-settled', onKeyboard);
    window.addEventListener('oc:keyboard-intent', onKeyboard);
    return () => {
      session.current = null;
      window.removeEventListener('oc:keyboard-settled', onKeyboard);
      window.removeEventListener('oc:keyboard-intent', onKeyboard);
      owner.dispose();
    };
  }, []);
  useEffect(() => { session.current?.update(snapshot); }, [snapshot]);
  return null;
};

export const AndroidCompanionController = () => {
  const { dualScreen } = useNativePreferences();
  return getClientPlatform() === 'android' && dualScreen ? <EnabledCompanion /> : null;
};
