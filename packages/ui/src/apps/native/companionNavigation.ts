import type { MobileWorkspaceTab } from '../mobileWorkspaceTabs';
import type { CompanionTab } from './companionModel';
export const companionWorkspaceTab = (tab: MobileWorkspaceTab): CompanionTab | null => tab === 'changes' ? 'review' : tab === 'files' ? 'artifacts' : tab === 'extensions' ? 'extensions' : tab === 'context' ? 'context' : null;
/** Route only when the native window is active. Every other case keeps the drawer. */
export const openCompanionWorkspace = (tab: MobileWorkspaceTab) => {
    const target = companionWorkspaceTab(tab);
    if (!target || typeof document === 'undefined' || document.documentElement.dataset.androidCompanionState !== 'active' || document.documentElement.classList.contains('oc-keyboard-open') || document.visibilityState === 'hidden')
        return false;
    window.dispatchEvent(new CustomEvent('oc:companion-workspace', { detail: { tab: target } }));
    return true;
};
