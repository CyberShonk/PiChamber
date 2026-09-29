# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered by
`components/layout/ContextPanel.tsx`.

## Model

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces, currently Preview, are hidden until
  a tab of their mode exists, and stay visible while in use.
  `availability: 'github-repo'` surfaces (Pull requests, Issues) are visible
  when the current directory's scope contains at least one GitHub
  repository, hidden while scope is loading with no result yet, and visible
  when scope resolution FAILED so the failure renders instead of looking
  absent. An open tab keeps its surface visible even if scope went away.
- `CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION` is the panel width as a fraction of
  the content area for every surface. A user resize is stored once per
  directory (`contextPanelByDirectory[dir].width`) and applies to every rail
  surface.
- Git includes working-tree diffs, so there is no separate Changes rail. The
  Git rail uses the Changes icon and label when the current directory is not a
  Git repository. Pull requests and Issues are `github-repo` rail surfaces
  backed by the GitHub integration (`components/views/github/`).
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts.ts`): it hides `has-content` surfaces until a tab of their mode exists
  and evaluates `github-repo` against the current directory's scope state
  (`githubScope`: loading/has-result/has-repo/has-error). Both consumers use
  it so the digit shown on a rail badge always maps to the same surface the
  shortcut opens.

## Adding a surface

1. Add a `ContextPanelMode` value in `useUIStore` (type union plus the
   sanitizer whitelist in `sanitizeContextPanelTabs`).
2. Register a descriptor here (icon, label, availability).
3. Render the mode in `ContextPanel.tsx` (content dispatch, label, icon).
   Surfaces whose list actions belong in the panel top header (terminal,
   git, diff, pull-requests/issues) portal them into a header slot there
   (a div with a ref callback into state, passed down gated by visibility
   as `isActive ? slot : null`); the surface `createPortal`s into it only
   while its list route is shown, so detail routes leave the slot empty.
4. Provide direct user-facing `label` and `description` in the descriptor.

No new header buttons: the rail and `openContextSurface` are the only entry
points for opening surfaces directly; deep links from chat/palette go through
the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, or an in-content link.
- Multi-instance and stateful surfaces (file/editor, browser, terminal) are
  keep-alive panes in `ContextPanel.tsx`: switching surfaces must not reset
  their state (open tabs, xterm session, scroll positions).
  Singleton surfaces (git, context, pull-requests, issues) and preview tabs intentionally
  remount on switch and must restore themselves from their stores/snapshots
  instead. Git embeds a stacked diff list of changed files, collapsed until
  the user expands a file. Pull requests / Issues restore list filters,
  selection, and scroll from their stores.
- Runtime scope: desktop/web `MainLayout` only. The dedicated Capacitor mobile
  shell has its own layout and does not consume this registry: phone drawer +
  tablet side panel/header tabs live in `apps/mobileWorkspaceTabs.ts` and
  render the same `PullRequestsSurface` / `IssuesSurface`. Mobile reuses the
  same `github-repo` rule through `isGitHubRepoAvailable` /
  `toGitHubRailScopeState` (hidden while scope loads, visible with >=1 repo
  or on scope failure); unlike the rail it falls back to Changes instead of
  keeping an open tab visible. Hosted mobile / narrow web use this rail path
  directly (list → detail stack at narrow widths), so no separate mobile
  handling exists there.
