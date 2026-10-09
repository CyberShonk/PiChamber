import { describe, expect, test } from 'bun:test';
import { getVisibleMobileWorkspaceTabs, resolveMobileWorkspaceTab, sanitizeMobileWorkspaceTab } from './mobileWorkspaceTabs';

describe('mobile workspace destinations', () => {
  test('hosted mobile keeps its original destinations and rejects native-only selections', () => {
    expect(getVisibleMobileWorkspaceTabs(false).map((tab) => tab.id)).toEqual(['changes', 'files', 'terminal']);
    expect(getVisibleMobileWorkspaceTabs(true).map((tab) => tab.id)).toEqual(['changes', 'files', 'terminal', 'pull-requests', 'issues']);
    expect(sanitizeMobileWorkspaceTab('context')).toBe('changes');
    expect(sanitizeMobileWorkspaceTab('extensions')).toBe('changes');
  });

  test('context and extensions are accessible without a GitHub repository', () => {
    expect(getVisibleMobileWorkspaceTabs(false, true).map((tab) => tab.id)).toEqual([
      'changes', 'files', 'terminal', 'context', 'extensions',
    ]);
    expect(getVisibleMobileWorkspaceTabs(true, true).map((tab) => tab.id)).toEqual([
      'changes', 'files', 'terminal', 'pull-requests', 'issues', 'context', 'extensions',
    ]);
  });

  test('new destinations and existing selections survive sanitization', () => {
    for (const tab of getVisibleMobileWorkspaceTabs(true, true)) {
      expect(sanitizeMobileWorkspaceTab(tab.id, true)).toBe(tab.id);
    }
    for (const value of [undefined, null, '', 'unknown', 0, {}]) {
      expect(sanitizeMobileWorkspaceTab(value, true)).toBe('changes');
    }
  });

  test('scope loss only replaces GitHub destinations', () => {
    for (const tab of getVisibleMobileWorkspaceTabs(true, true)) {
      expect(resolveMobileWorkspaceTab(tab.id, true)).toBe(tab.id);
      expect(resolveMobileWorkspaceTab(tab.id, false)).toBe(
        tab.id === 'pull-requests' || tab.id === 'issues' ? 'changes' : tab.id,
      );
    }
  });
});
