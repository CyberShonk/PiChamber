# Mobile App Surfaces — Gesture and Layout Contracts

## Gesture Ownership

- **Phone drawers** (`MobileSessionsSheet`, `MobileWorkspaceDrawer` with `variant=\"drawer\"`) own their drag surfaces via `useDrawerSwipe`. The drawer element itself is the touch surface (portaled to `document.body`), outside the chat. `useEdgeSwipe` owns the **chat** surface (`chatMainRef`) for opening drawers from content. Tablet sidebars own a separate two-layer panel surface.

- **Event surfaces are distinct** because phone drawers are portaled outside the chat element. Sharing geometry (`gestureMath`) is intentional, but hooks remain separate: `useDrawerSwipe` attaches to the drawer/scrim, `useEdgeSwipe` attaches to the chat. Do not merge the hooks; keep the event targets separate.

- **Direction is decided once** after `DRAG_THRESHOLD` and `MAX_OFF_AXIS`. Vertical or wrong-direction gestures reset tracking without side-effects. Both left and right panels follow the same `gestureMath` thresholds (`VELOCITY_THRESHOLD`, `SETTLE_PROGRESS`).

## Abort and Cleanup Invariants

- **Single cancellation path**: `cancelGesture` in `useDrawerSwipe` and `cancelGesture`/`abortDraggingWithSnap` in `useEdgeSwipe` always:
  - Restores drawer to known starting state (`transform: none` when open, scrim `opacity: 1`, `pointerEvents: auto`).
  - Restores `transition` (phone: `MOBILE_DRAWER_DURATION_MS` easing; tablet inner: `200ms cubic-bezier(0.22,1,0.36,1)`).
  - Clears transient flags (`tracking`, `isDragging`, `hasDecided`); progress is kept in refs rather than per-frame DOM datasets.
  - Never calls `onClose` for an aborted gesture.

- **Triggers**: multi-touch (`touches.length !== 1`), `touchcancel`, and hook cleanup/unmount all go through the same path. A second drag starting before the previous settle finishes interrupts the running transition (`transition: none` on the new `touchstart`) and recomputes from the current finger.

- **Settle only fires `onClose` for a committed close** (progress < `SETTLE_PROGRESS` or closing fling). Aborted gestures snap back to `wasOpen` with an explicit `onLeftProgress( wasOpen ? 1 : 0 )` + `onDragEnd(wasOpen)`.

- **Stale timeouts are cleared** via `dragTimeoutsRef` in `MobileShell` before any new drag or open/close state change.

## Ref-Based Surface Control (No Per-Frame Queries)

- `MobileShell` owns `phoneLeftDrawerRef` / `phoneLeftScrimRef` / `phoneLeftRootRef` (and right equivalents) and passes them into `MobileSessionsSheet` / `MobileWorkspaceDrawer` via `drawerRefExternal` etc. The drawer components merge external and internal refs with callback refs.

- `useEdgeSwipe`'s `onLeftProgress`/`onRightProgress` mutate **only via refs** (`applyPhoneDrawerProgress`, `applyTabletPanelProgress`). No `document.querySelector` or `getBoundingClientRect` per `touchmove`. Width helpers use `ref.current?.offsetWidth` (fallback `window.innerWidth`), not queries.

- **Drawer-surface adapter** (`drawerSurface.ts`) owns all imperative style writes. `MobileShell` is responsible only for open state (`setSidebarOpen`, `setSessionsSheetOpenSafely`, `setWorkspaceOpenSafely`) and for committing `didSettleOpen` after `finish`. No React `setState` occurs inside `onLeftProgress`/`onRightProgress`.

- **Verification**: `bun test -t \"mobile drawer lifecycle\"` asserts no `querySelector` in the hot path, that closed tablet shells use `inert`, and that `MobileShell` no longer contains `style.transition = ''` for React-owned closed styles. The chat tree and panel modules are memoized so sidebar state changes do not rerender unrelated heavy surfaces.

## Tablet Layout Without Reflow

- **Two layers**:
  - Outer *layout shell* (`aside` with `asideRef`) owns `width`/`minWidth`/`maxWidth` (0 when closed, `leftResize.width` / `rightResize.width` when open) and commits layout width without a CSS width transition.
  - Inner *surface* (`leftPanelInnerRef` / `rightPanelInnerRef`) owns a fixed `width: var(--oc-ipad-sidebar-width)` and `transform`.

- **During an opening drag** (closed → preview), shell stays `width: 0` and `overflow: visible`; inner translates from `translateX(-w)` (left) or `translateX(w)` (right) toward `0`. Chat does not reflow per-move. Closed tablet shells use `inert`, and the session sidebar receives `isVisible={false}`, so hidden sidebar work is gated.

- **During a closing drag** (open → preview), shell stays `width: w` and inner translates outward. Only `inner.transform` is mutated per-move.

- **On settle or cancellation**, inner animates to its final `translateX` with `200ms` easing, and temporary shell overflow is cleared after `220ms`. The shell's `width` is committed via React state (`sidebarOpen`/`workspaceOpen`) once; it is not CSS-transitioned, so chat reflows once instead of on every animation frame.

- Both sides and both directions are covered; `usePanelSlide` still drives the non-drag open/close `transform` for the left sidebar's inner surface.

- **Toggle-only titlebar controls** have a fixed `2.5rem` header reservation. Do not measure and publish their width through root CSS variables on each sidebar toggle: those geometry reads synchronously resolve the invalidated layout tree. Window chrome is fixed (classic minimize/maximize/close on the right for frameless Windows/Linux; native OS-owned traffic lights on macOS), so the left overlay only holds the frameless app menu plus the sidebar toggle. Only the frameless app-menu cluster is measured, to preserve the existing `--oc-titlebar-controls-width` / `--oc-titlebar-overlay-width` reservation contract with the header and sidebar strip.

## Horizontal-Scroll Exclusions

- **Shared predicate**: `isSwipeExcludedTarget` in `gestureMath` (selector `button, a, input, textarea, select, [contenteditable], [data-no-drawer-swipe]` + `scrollWidth > clientWidth && overflowX auto|scroll`). Single source for both hooks. `useEdgeSwipe` (content surface) always excludes interactive controls; `useDrawerSwipe` (drawer-local close) passes `{ excludeInteractive: false }` so a swipe anywhere on the drawer can close it — only the explicit `[data-no-drawer-swipe]` marker and horizontal scrollers remain excluded.

- **Applied for both open and closed states on the content surface**: `useEdgeSwipe` checks `isSwipeExcludedTarget` before tracking even when a drawer is already open. Previously it only checked when closed, causing horizontal scroll inside code blocks / terminal / composer / tab lists to be hijacked as a close gesture.

- **Explicit markers** (`data-no-drawer-swipe="true"`) on:
  - `MobileWorkspaceDrawer` tab strip
  - `ComposerFooter` mobile actions
  - `TerminalView` quick-keys bar
  - `MessageBody` code `pre` / font-mono blocks
  - `FileAttachment` scroll container
  - `SidebarHeader` mobile tabs
  - `Header` main tab strip
  - `FilesView` editor tabs, `PierreDiffViewer`

- **Touch-action**: chat containers (`chatMainRef`, `mainInteractiveRef`, drawer drawers) use `pan-x pan-y` (previously `pan-y`) so horizontal descendants can scroll natively; `preventDefault` is only called after horizontal intent is locked.

## Shared Mobile Files and Changes Ownership

- Dedicated mobile no longer owns parallel Files or Changes controllers. `MobileWorkspaceDrawer` lazy-loads the shared `FilesView` and `GitView` entrypoints instead.
- Files uses `FilesView chrome="mobile" mode="editor-only" isVisible={open && tab === 'files'}`. `components/views/files/MobileFilesChrome.tsx` owns the mobile list/header presentation. Shared directory loading and polling live in `useFilesTree`; search request policy for both `FilesView` and `SidebarFilesTree` lives in `useFilesViewSearch`; file mutations for both surfaces live in `useFileOperations`. `loadFileDocument` owns file-kind classification plus text normalization. `useFileEditorSave` owns guarded writes, line-ending serialization, manual-save status, and autosave timing. `useDirtyFileNavigation` owns the single pending selection, close, or main-tab intent while the unsaved-changes modal is active. `useFileViewerModes` owns per-file preview choices, preference propagation, and the Draw.io preview/save lifecycle. `useFileEditorNavigation` coordinates deferred file selection, editor mounting, focus requests, and line jumps. `useFileStatReconciliation` polls authoritative metadata without overwriting dirty drafts or treating stat failures as missing files. `FilesView` composes those modules with selection, stale-load rejection, tabs, and editor presentation. Mobile path helpers live beside that chrome in `components/views/files/mobileFilesPaths.ts`.
- File-tree refresh is explicitly gated: `FilesView` computes `needsTree` via `shouldEnableFilesTree(chrome, mode)` — mobile always needs its tree, desktop `full` needs `FilesTreePanel`, desktop `editor-only` is disabled because its tree column is the separate `SidebarFilesTree`. `useFilesTree({ enabled, visible })` issues no requests when disabled, issues no polling when hidden, keeps cached rows, and resumes once on reactivation. Unchanged refreshes preserve bucket references across all render-relevant `FileNode` fields (`name`, `path`, `type`, `extension`, `relativePath`, `size`); only changed buckets republish. Stale scope completions are rejected by scope plus generation, concurrent same-dir loads share one fetch while polling/catch-up skips in-flight dirs (explicit refresh forces a new fetch), and one failed directory never clears unrelated buckets. Desktop `ContextPanel` passes `isVisible={isOpen && isFileTabActive}` so its keep-alive `FilesView` stops polling while hidden without discarding dirty drafts.
- Changes uses `GitView chrome="mobile"`. `components/views/git/MobileGitChrome.tsx` owns the mobile list/detail route and presentation; `GitView` owns authoritative status, remotes, index mutation queue/rollback, revert, commit, sync, and diff prefetch. The drawer passes `isActive={open && tab === 'changes'}` so hidden Changes work stays gated.
- Every drawer tab (Changes, Files, Terminal, Pull requests, Issues) starts with `MobileSurfaceHeader`: one `h-11` row, 12px leading inset, 36px trailing icon buttons. Tab-specific chrome must render through its `leading`/`title`/`actions` slots rather than a bespoke header so the tabs stay visually aligned on tablet and phone.
- Mobile commit/sync behavior stays visually scoped to the mobile surface: desktop commit-and-push fireworks are not triggered by `chrome="mobile"`.
- The Files consolidation is not a startup-performance claim. Opening the mobile Files tab currently loads the full `FilesView` module, including editor/preview dependencies. A later split should move editor-heavy implementation behind an on-demand boundary so browsing a directory does not pay that cost before a file is opened.

## Standalone diagram saves

`components/views/DiagramView.tsx` uses the same guarded-write contract and
`FileSaveConflictDialog` as the Files view. A conflict preserves the editor
buffer and offers explicit reload, overwrite, and comparison. Reload discards
edits only after a successful read, including when the disk bytes match the
original editor prop. Overwrite captures the latest buffer at the click, and
neither save path resets edits made while the write is pending. File/runtime
switches invalidate pending completions and reset action ownership; a failed
initial read offers no editable, unguarded fallback. Failed conflict reloads
leave the dirty editor intact.

## Runtime Git Ownership

- UI feature code consumes the injected `RuntimeAPIs.git` contract directly. The old `lib/gitApi.ts` forwarding layer was removed because it duplicated the runtime-vs-HTTP decision for every method. React surfaces resolve Git through `useRuntimeAPIs()`; non-React callers that can run before a provider exists keep a narrow `gitApiHttp` fallback at the call site.
- `git/gitStatusPredicates.ts` and `git/gitChangeDescriptors.ts` define the shared staged, working, and new-file classification and change descriptors used across `GitView`, `ChangeRow`, and `DiffView`; untracked `?` entries remain working changes rather than staged changes. Branch-only history requests use the same resolvable-base gate as branch comparison controls, so a conventional `main` fallback that is absent locally and remotely never reaches the Git log API.
- Diff presentation is modularized under `components/views/diff/`: scope filtering (`ChangeScopeSelector`), file list selection (`FileList`), diff presentation (`InlineDiffViewer`, `InlineImageDiffViewer`), per-file staging/revert controls (`FileDiffActions`), and stacked entry orchestration (`MultiFileDiffEntry`) isolate diff rendering concerns from `DiffView`.
- Optional runtime capabilities such as commit-file diff and credential discovery fall back only for that capability; they do not reintroduce a broad compatibility adapter. Types come from `lib/api/types.ts`.

## Git View Lazy Mount

- `MainLayout` does not mount `GitView` on initial mobile chat startup. It mounts the right-drawer view only when `(mobileRightSidebarOpen || mobileRightDrawerVisible)`; a route-addressable mobile `activeMainTab === 'git'` mounts the full view only when the drawer is closed, so `?tab=git` cannot produce a blank main area.

- Draft/identity state survives drawer unmount via `gitViewSnapshots` (per-directory LRU in `git/gitViewSnapshots.ts`). Branch integration and commit log/history dialogs live in `git/UpdateBranchDialog.tsx` and `git/GitHistoryDialog.tsx`.

- Hidden `useGitStore` selectors and `isActive`-gated effects do not run while the drawer is closed because the component is not mounted. The `GitView` chunk is not requested during initial mobile startup (verified via Network panel: no `GitView` request before the first right-drawer open).

## Mobile Workspace GitHub Tabs

- `mobileWorkspaceTabs.ts` owns `MobileWorkspaceTab` (`changes` | `files` | `terminal` | `pull-requests` | `issues`), the drawer/header tab definitions (short labels "PRs" / "Issues"), and the pure helpers `sanitizeMobileWorkspaceTab`, `isMobileGitHubTab`, `getVisibleMobileWorkspaceTabs`, `resolveMobileWorkspaceTab`.
- Availability reuses the shared `github-repo` rule: `MobileShell` resolves the effective directory, ensures scope through `useGitHubScopeStore` (same path as the desktop rail), derives `toGitHubRailScopeState` + `isGitHubRepoAvailable` from `lib/surfaces/registry`, and passes a boolean down. The drawer and the tablet header switcher stay presentation-only. Tabs hide while scope loads with no result, show with >=1 GitHub repo, and show on scope failure so the failure renders inside the surfaces.
- An active GitHub tab that becomes unavailable falls back to Changes (`resolveMobileWorkspaceTab` effect in `MobileShell`). Mobile has no rail-style open-tab exception: scope failure counts as available, so the fallback only fires while loading or at zero repos.
- Keep-alive follows the drawer's `visitedTabs` precedent: PRs/Issues panes stay mounted once visited (hidden with `hidden`), unlike desktop's singleton remount-on-switch. Restoration comes from staying mounted plus the stores' last-known-first snapshots; hidden cost is focus-gated revalidation only (no list polling). The `PullRequestsSurface` / `IssuesSurface` chunks lazy-load on first visit, like Files/Git.
- Intentional v1 parity differences with desktop: PR detail is Overview + Checks (the drawer renders `PullRequestsSurface hideFilesTab`, which omits the Files tab and skips the files fetch; Files/review on mobile is a follow-up), and there is no composer link picker on mobile. Drawer tab buttons meet 44px touch targets (`min-h-[44px]`, `size-11` close); the tablet header workspace switcher uses 44px icon buttons; safe-area insets follow the existing drawer precedent.

## Tablet-Layout Subscriptions

- `useTabletLayout` is now `useSyncExternalStore` with a single global `resize` listener and a single `matchMedia('(orientation: landscape)')` listener. Stable snapshots (`isSameTabletLayout`) avoid re-renders when values are equal.

- SSR snapshot is `{ enabled: false, roomyForPanels: false }`. Cleanup removes listeners and nulls the snapshot when the last consumer unsubscribes. Fold/orientation transitions are coalesced via `requestAnimationFrame`.

- `readTabletLayout` remains the pure geometry helper (phone vs tablet vs foldable vs `isIPadApp` override, `WORKSPACE_PANEL_MIN_WIDTH_PX` gate).

## Validation Checklist

- `bun test` — `gestureMath.test.ts` (velocity/progress, two-finger, touchcancel, second-drag, tablet open), `tabletLayout.test.ts`, `mobileDrawerLifecycle.test.ts`, `mobileWorkspaceTabs.test.ts` (github availability, visible tabs, sanitizer, fallback).
- `bun run type-check` — workspace-wide.
- `bun run lint` — workspace-wide (only pre-existing `ComposerEditor` warning).
- `bun run dead-code` — no new unused exports.
- `git diff --check` — no whitespace errors.
- Manual profiles on a WebView/Chrome: no `querySelector` in `touchmove` timeline, no Git chunk before drawer open, no React renders from drag moves, no stale transforms after `touchcancel`/multi-touch, horizontal scrolling in code/terminal/composer/tabs remains functional.

## Failure and Rollback

- A failed gesture leaves the drawer in its starting state (open or closed) with transitions cleared. No partial opacity/transform remains.
- A failed `readTabletLayout` (e.g., `window` undefined during SSR) returns the default layout without throwing.
- `GitView` mount failure does not affect chat; the drawer can be retried. No optimistic state is stranded.

## Native mobile presentation

`MobileShell` sets `MobileAppActions.nativeApp` only for the Capacitor shell.
The hosted browser mobile app leaves it false. Shared presentation components
use this explicit capability rather than screen width to enable native features.

Native workspace navigation adds Context and Extensions. Both load on demand
and mount only while open and selected. Native pull requests include Code and
inline review; hosted mobile retains its summary-only view. The tablet native
workspace strip scrolls to accommodate the extra destinations. Hosted tab lists
and tab sanitization retain the original five destinations.

The native phone sessions drawer uses 92% width, including its swipe geometry.
Hosted mobile retains 72%. The native sidebar starts in a local Recent view,
offers Projects, keeps search visible, and puts actions in a separate footer.
`nativeAppVariant` is an opt-in shared presentation prop; ordinary mobileVariant
callers retain their previous header, view preference, padding, and floating
actions. Tablet sidebar view preferences remain unchanged.

`NativeMobileSessionSwitcher` owns the native search and 50-session list. The
existing hosted switcher stays at 10 sessions without search. The native module
is lazy-loaded only through the app-capability branch. Both consume the existing
shared catalog and selection actions. Native search matches title, project,
branch, and directory without issuing additional requests.

Native lifecycle recovery arms on Capacitor pause. Android also uses WebView
hidden visibility; iOS does not, because overlays can hide the WebView.
On iOS, appStateChange(false) also occurs for system overlays, so it changes
active chrome without arming recovery. Resume, active, and visible signals
consume a real background cycle once. The hook retains listeners across
callback updates, uses the latest committed callback, and removes them on
unmount. Existing heartbeat and online recovery still handle broken connections.

Mobile connection candidate probing rejects missing or mismatched server IDs
when pairing metadata provides an expected ID. Credential dispatch follows
that identity check. Server URLs permit HTTP and HTTPS and reject embedded
credentials. These are client connection changes; the host API is unchanged.

### Device conveniences

`apps/native` owns device-local appearance, feedback, quick navigation, explicit
read-only offline copies and status. `ThemeSystemProvider.additionalThemes` and
`localPreferencesOnly` are optional native seams; other roots retain their
existing preset and persistence behavior. Native preferences use a separate
storage namespace and do not write host appearance settings.

Quick navigation mounts on demand, searches the existing 50-parent catalog and
frozen loaded transcript records, and renders at most 100 transcript results.
Its search index rebuilds when those records change, not on each keystroke.
Attention includes newly observed completion/error events scoped to the runtime;
it never treats persisted history as live activity. Offline copies are explicit,
opt-in, limited to three UTF-8 payloads of 600 KB including metadata, and displayed
in a separate read-only surface. They never hydrate sync stores or queue sends.

Native push registration subscribes to runtime identity and re-registers with
each connected host. Listener cleanup, bounded retries and generation checks
reject late results. Device permission and host registration are separate
statuses. Disabling unregisters the device and removes the current host token
where possible; it never routes an old-host removal to a new host.

`NativeAppPlugin.swift` supplies iOS haptics, Settings, notification testing,
terminal paste confirmation and native file sharing without new dependencies.
The shell publishes docked keyboard frame geometry, duration, curve and Reduce
Motion state. New shells use those frames, including height changes and
interactive dismissal; older shells retain the Capacitor event fallback.
Pairing HTTP requests reject redirects and retain system TLS trust. Diagnostic
categories are sanitized before display or logging; raw request exceptions and
URLs are not copied into the native error hint.

Relay session probes classify non-authentication HTTP failures as unreachable,
retaining credentials for recovery. HTTP 401 or an explicit unauthenticated
session still requires sign-in. Native push errors classify missing iOS push
entitlements without displaying raw native error payloads.

Native tokenless saved connections probe the host before deciding whether sign-in
is required. Only an explicit auth-disabled session permits native access without
a bearer; cookies cannot stand in for a missing credential. Secure read failures
remain retryable. Successful tokenless connections clear stale hasToken metadata.
NativeOnDemand resolves Quick navigation and the native composer GitHub picker
through committed state, with failure and retry UI and late-unmount cancellation.
