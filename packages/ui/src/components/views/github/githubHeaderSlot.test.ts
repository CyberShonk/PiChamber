/**
 * Regression guard: the PR/Issues list action controls (Refresh + the
 * primary action such as New issue) live in the host top header row, while
 * the list toolbar (second row) keeps only search + filters.
 *
 * Contract (TerminalView `terminalHeaderSlot` / ContextPanel precedent):
 * - Hosts own the slot (`ContextPanel` github slot for desktop,
 *   `MobileWorkspaceDrawer` one slot per tab for mobile/tablet) and pass it
 *   down (`PullRequestsSurface` / `IssuesSurface` → `PullsList` /
 *   `IssuesList` → `GitHubListView` as `headerActionsSlot` plus
 *   `headerActionsPresentation`), gated by visibility
 *   (`isActive ? slot : null`).
 * - `GitHubListView` portals Refresh + `primaryAction` into the slot and
 *   keeps search + `toolbarControls` (Filters/Sort) inline; without a slot
 *   (any other host) actions render inline in the toolbar as before.
 * - Filters/Sort stay inline as borderless ghost `Button`s (h-8); header buttons use shared ghost
 *   `Button`s (desktop `h-8 w-8`, drawer 36px touch targets, `size-4`
 *   icons).
 * - Detail/form routes unmount the list, so the portal unmounts and the
 *   header never shows list actions.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(__dirname, relative), 'utf-8');

const listViewSource = read('GitHubListView.tsx');
const filtersMenuSource = read('GitHubFiltersMenu.tsx');
const pullsListSource = read('pulls/PullsList.tsx');
const issuesListSource = read('issues/IssuesList.tsx');
const pullsSurfaceSource = read('PullRequestsSurface.tsx');
const issuesSurfaceSource = read('IssuesSurface.tsx');
const drawerSource = readFileSync(
  join(__dirname, '..', '..', '..', 'apps', 'MobileWorkspaceDrawer.tsx'),
  'utf-8',
);
const contextPanelSource = readFileSync(
  join(__dirname, '..', '..', '..', 'components', 'layout', 'ContextPanel.tsx'),
  'utf-8',
);

describe('github header actions slot', () => {
  test('GitHubListView portals action controls into the header slot', () => {
    expect(listViewSource).toContain('headerActionsSlot');
    expect(listViewSource).toContain('primaryAction');
    expect(listViewSource).toContain('headerActionsPresentation');
    expect(listViewSource).toContain('createPortal');
  });

  test('the toolbar keeps search plus filters when portalled', () => {
    expect(listViewSource).toContain('{toolbarControls}');
    // Actions render inline only when no slot is provided (fallback).
    expect(listViewSource).toContain('{headerSlot ? null : (');
    expect(listViewSource).toContain('{primaryAction}');
  });

  test('filters/sort keep toolbar chrome while refresh supports header sizes', () => {
    // Filters/Sort never portal: no header presentation, ghost toolbar buttons.
    expect(filtersMenuSource).not.toContain('dropdownTriggerVariants');
    expect(filtersMenuSource).toContain('variant="ghost"');
    expect(filtersMenuSource).not.toContain("presentation === 'header'");
    // Refresh renders ghost header buttons sized per host.
    expect(filtersMenuSource).toContain("presentation === 'desktop'");
    expect(filtersMenuSource).toContain("presentation === 'drawer'");
    expect(filtersMenuSource).toContain('variant="ghost"');
    // Desktop header matches the panel's h-8 header buttons.
    expect(filtersMenuSource).toContain('h-8 w-8');
  });

  test('pulls/issues lists split the primary action from the filter controls', () => {
    expect(pullsListSource).toContain('headerActionsSlot');
    expect(pullsListSource).toContain('headerActionsPresentation');
    expect(issuesListSource).toContain('headerActionsSlot');
    expect(issuesListSource).toContain('headerActionsPresentation');
    expect(issuesListSource).toContain('primaryAction');
  });

  test('surfaces only portal while the list is shown', () => {
    expect(pullsSurfaceSource).toContain('headerActionsSlot');
    expect(pullsSurfaceSource).toContain('headerActionsPresentation');
    expect(issuesSurfaceSource).toContain('headerActionsSlot');
    expect(issuesSurfaceSource).toContain('headerActionsPresentation');
    // Detail/form branches return before the list, so the portal unmounts.
    expect(pullsSurfaceSource).toContain('PullDetailLoader');
    expect(issuesSurfaceSource).toContain('showForm');
  });

  test('the drawer owns one header slot per tab and gates each by visibility', () => {
    expect(drawerSource).toContain('prHeaderSlot');
    expect(drawerSource).toContain('issuesHeaderSlot');
    expect(drawerSource).toContain('setPrHeaderSlot');
    expect(drawerSource).toContain('setIssuesHeaderSlot');
    expect(drawerSource).toContain("headerActionsSlot={open && tab === 'pull-requests' ? prHeaderSlot : null}");
    expect(drawerSource).toContain("headerActionsSlot={open && tab === 'issues' ? issuesHeaderSlot : null}");
    expect(drawerSource).toContain('headerActionsPresentation="drawer"');
  });

  test('the desktop context panel hosts list actions in its header', () => {
    expect(contextPanelSource).toContain('githubHeaderSlot');
    expect(contextPanelSource).toContain('setGithubHeaderSlot');
    expect(contextPanelSource).toContain('isPullRequestsPanelActive');
    expect(contextPanelSource).toContain('isIssuesPanelActive');
    expect(contextPanelSource).toContain('headerActionsPresentation="desktop"');
  });
});
