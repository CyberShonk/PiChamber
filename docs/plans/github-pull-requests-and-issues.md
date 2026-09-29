# Plan: Native GitHub Pull Requests and Issues

Status: accepted
Scope: web, desktop, hosted mobile, Capacitor mobile

## 1. Goal

Let users browse, review, and act on GitHub pull requests and issues for the
repository they are working in, without leaving PiChamber. The agent should be
able to receive PR and issue context directly: the issue to work on, the failing
checks, the review comments to address.

## 2. Principles

1. **One account, owned by the GitHub CLI.** PiChamber uses the account that
   `gh` has active on the server machine. PiChamber adds no login flow, stores
   no tokens, and has no account switcher. A user who already ran
   `gh auth login` gets a working integration with zero setup.
2. **Never change shared user state.** PiChamber never writes global or
   repository git config, never runs `gh auth switch`/`login`/`logout`, and
   never touches `~/.git-credentials`. Another editor or terminal on the same
   repository sees exactly what it saw before.
3. **Server-side only.** Every GitHub call runs on the PiChamber server. The UI
   talks to `/api/github/*` through `RuntimeAPIs.github`, so web, desktop,
   hosted mobile, and Capacitor share one code path. Tokens never reach a
   client, a log line, a prompt, or an error message.
4. **Authoritative or explicit.** A failed fetch is never shown as an empty
   list. "Not a GitHub repository", "gh not installed", "gh not signed in",
   "no access", "rate limited", and "request failed" are distinct states with
   distinct copy.
5. **Visible, not hidden.** The acting account is always shown. Missing
   capability (scope, permission) is explained in place, not silently hidden.
6. **No new dependencies.** GitHub REST and GraphQL are called with the
   runtime's native `fetch`.

## 3. Account and credential model

### 3.1 Source of truth

- Detect: resolve the `gh` binary with the server's login-shell PATH, then
  `gh auth status --json hosts` (fallback to plain `gh auth status` parsing for
  older versions). Report per host: installed, authenticated, active login,
  token scopes.
- Token: `gh auth token --hostname <host>` via `execFile` (no shell), 5 s
  timeout, held in memory only, cached briefly (≈30 s) per host.
- Minimum gh version is enforced and reported (exact floor to be set when
  implementing, based on the `--json` flags used).

### 3.2 Pinning per operation

Each logical operation (one list read, one detail read, one action plus its
follow-up refresh) reads the token once at the start and uses that same token
for every request in the chain. If the user runs `gh auth switch` mid-operation,
the operation finishes on the account it started with; the next operation picks
up the new account.

- Cache keys that depend on the account use `sha256(host + token)`, never the
  token itself. Switching accounts therefore naturally partitions caches.
- The resolved viewer (`GET /user`) is cached per token fingerprint for
  ≈10 minutes; only successes are cached.

### 3.3 Host safety

- A token is only ever sent to the API host that matches the repository remote
  it was resolved for (`api.github.com` for `github.com`; `https://<host>/api/v3`
  and `/api/graphql` for a GitHub Enterprise host gh is signed into).
- Links pasted into chat or found in PR/issue bodies are never fetched with
  credentials unless they point at a host the user is signed into and a
  repository PiChamber resolved from a local remote.
- v1 ships `github.com`. The client is host-aware from day one so Enterprise
  hosts can be enabled later without restructuring.

### 3.4 Git transport is separate

Commits and pushes keep using the user's normal git configuration and
credentials. The UI states this plainly where it matters (push failures,
settings): the account used for PRs and the credentials used for `git push`
can differ, and PiChamber does not change either.

Background git reads run fail-closed: `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, and empty `GIT_ASKPASS`/`SSH_ASKPASS`, so a credential
prompt fails fast and is reported instead of hanging.

### 3.5 Retiring git identity profiles

The existing git identity feature writes repository-local git config
(`user.name`, `user.email`, `core.sshCommand`, `credential.helper`, signing
keys). It also does this silently in two places: the Git view applies the
default identity to any repository without a local identity when it opens, and
clone applies the chosen identity to the new checkout. Both break principle 2,
and token mode's `credential.helper store` does not reliably control which
account a push uses. The feature is removed:

- Server:
  - remove `identity-storage.js`, `credentials.js`
    (`discoverGitCredentials`), and `setLocalIdentity`;
  - remove the `/api/git/identities*`, `global-identity`,
    `discover-credentials`, `has-local-identity`, and `set-identity` routes;
  - remove the clone-time identity (`resolveCloneGitIdentity` in
    `fs/routes.js`).
- UI:
  - remove the Git settings identities page (`sections/git-identities/*`),
    `useGitIdentitiesStore`, `gitIdentitiesHttp`, `IdentityDropdown`,
    `useGitIdentities`, the Git view's default auto-apply, the clone dialog's
    identity picker, and the `defaultGitIdentityId` setting (dropped by the
    settings sanitizer);
  - remove matching locale keys.
- Kept (read-only): the Git view shows **Committing as Name &lt;email&gt;**,
  resolved by git (`getCurrentIdentity`), with a hint that this comes from the
  user's git config.
- Migration:
  - leave the user's saved profiles file on disk untouched;
  - leave git config previously written into repositories as-is (reverting it
    would be another write to shared state);
  - the release notes explain the removal and how to set identity with plain
    git (`git config user.email …`).

### 3.6 The agent

The agent's shell inherits the server environment unchanged. Its `git` and
`gh` behave exactly like the user's own terminal, on the same account. PiChamber
reduces how often the agent needs `gh` by fetching PR/issue/check data itself
and attaching it to messages (see §8).

## 4. Repository scope

A session directory can map to zero, one, or several GitHub repositories. One
server-side resolver owns this mapping, and every PR/issue surface uses it.

### 4.1 Discovery

For a session directory `D`:

1. **Containing repository**: `git rev-parse --show-toplevel` from `D`.
2. **Enclosing repository**: if the containing repository itself sits inside
   another working tree, walk upward from its parent (bounded: stop at the
   user's home directory or the filesystem root) and include the outer
   repository.
3. **Nested repositories**: bounded walk below the containing repository (or
   below `D` if `D` is not in a repository) for `.git` entries:
   - max depth 4, max 50 repositories, max 5 000 directories visited, 2 s
     budget;
   - skip `node_modules`, `.git`, build/output directories, and paths the
     enclosing repository ignores;
   - include submodules listed in `.gitmodules`, marked as submodules.
   - A budget cutoff returns a partial result flagged `truncated`, never a
     silent short list.
4. **Worktrees**: a linked worktree resolves to the same GitHub repository as
   its main checkout. Repository identity is `(host, owner, repo)`, not the path,
   so worktrees share caches and selection.

Discovery results are cached per directory with a short TTL and invalidated by
the existing git status refresh signals.

### 4.2 Mapping a local repository to GitHub

- Parse remote URLs (`https://`, `ssh://`, `git@host:owner/repo`), with or
  without `.git`. Non-GitHub hosts resolve to "not a GitHub repository" for
  that remote.
- Default remote: current branch's tracking remote → `origin` → `upstream` →
  first GitHub remote.
- Fork awareness: `GET /repos/{owner}/{repo}` reports `parent`. When the repo
  is a fork, lists offer a **This fork / Upstream** switch rather than merging
  the two into one list. Creating a PR from a fork targets upstream by default
  with `head = <forkOwner>:<branch>`.

### 4.3 Selection UX

- If exactly one GitHub repository is in scope, it is used and shown as a
  label in the surface header.
- If several are in scope, the header shows a **repository picker**. Entries
  read `<relative path> · owner/repo`, tagged `enclosing`, `nested`, or
  `submodule`. The selection is persisted per session directory in the
  existing per-directory UI state.
- Default selection: the containing repository if it is on GitHub; otherwise
  none is selected and the surface asks the user to pick.
- Non-GitHub repositories are listed as disabled with the reason.

The Git surface keeps its current directory scoping in v1. Sharing this
resolver and picker with the Git surface is a follow-up (§11).

## 5. Server design

New module: `packages/web/server/lib/github/` with its own `DOCUMENTATION.md`.

| File | Responsibility |
|---|---|
| `gh-cli.js` | Locate `gh`, version check, `auth status`, `auth token` (execFile, timeouts, no logging of output) |
| `credential.js` | Per-operation token pinning, token fingerprint, viewer cache |
| `client.js` | `fetch`-based REST + GraphQL client: per-request timeout (8 s), ETag conditional GETs (a `304` does not count against rate limits; cache keyed by fingerprint + URL, LRU bounded), rate-limit detection with `retryAt`, typed error mapping |
| `repo-scope.js` | §4 discovery and remote → repository mapping, fork parent lookup |
| `pulls.js` | List, detail, files/diff, checks, reviews/threads, actions, create/update |
| `issues.js` | List, detail, comments, create, update, comment |
| `checks.js` | Check runs + commit statuses rollup, job steps, annotations |
| `context.js` | Builds agent-facing context payloads with size budgets (§8) |
| `routes.js` | Thin Express adapter registering `/api/github/*` |

### 5.1 Error taxonomy

Every response is either a success payload or one of:

- `unavailable` with `reason`: `gh-missing`, `gh-outdated`,
  `gh-unauthenticated`, `not-github`, `no-repository`, `no-access`
  (403/404 on the repository), `scope-missing` (with the missing scope).
- `rate-limited` with `retryAt`.
- `failed` with a readable host message.

A 403/404 on repository lookup is `no-access`, never "no pull requests".
Rate-limited and timed-out reads may serve the last good cached value marked
`stale: true` with `fetchedAt`.

### 5.2 Caching and freshness

| Read | TTL | Notes |
|---|---|---|
| Lists (PRs, issues) | 30 s | Keyed by fingerprint + repo + filters + cursor |
| PR / issue detail | 15 s | |
| PR diff | 60 s, stale-while-revalidate up to 10 min | Keyed by head SHA where possible |
| Checks | 15 s | |
| Current-branch PR status | see §7.2 | |
| Viewer | 10 min | |

- Only successes are cached.
- In-flight identical reads are coalesced.
- Explicit refresh and post-action reloads go through an `invalidate` call, so
  an ordinary read never bypasses the cache.
- Background reads pause during a rate-limit window; user-initiated actions
  are still attempted and report the rate limit if it hits.

### 5.3 Routes (v1)

```
GET  /api/github/status                       gh install/auth/login/scopes per host
GET  /api/github/scope?directory=             repositories in scope (§4), selection hints
GET  /api/github/pulls?repo=&state=&filter=&q=&cursor=
GET  /api/github/pulls/:number?repo=          detail (+ reviews, threads, timeline)
GET  /api/github/pulls/:number/files?repo=&cursor=
GET  /api/github/pulls/:number/checks?repo=&details=
GET  /api/github/pr-status?directory=&branch= current-branch PR for the Git surface
POST /api/github/pulls                        create
POST /api/github/pulls/:number/actions        merge|squash|rebase|ready|draft|close|reopen|update-branch
POST /api/github/pulls/:number/comments       top-level comment
POST /api/github/pulls/:number/reviews        comment|approve|request-changes (+ inline comments)
POST /api/github/pulls/:number/threads/:id    reply | resolve | unresolve
PATCH /api/github/pulls/:number               title/body
GET  /api/github/issues?repo=&state=&filter=&q=&cursor=
GET  /api/github/issues/:number?repo=
POST /api/github/issues                       create
PATCH /api/github/issues/:number              title/body/state/labels/assignees
POST /api/github/issues/:number/comments
POST /api/github/invalidate                   { repo, kind?, number? }
```

`repo` is `host/owner/name` and must be one of the repositories the resolver
returned for a directory this server serves. The server rejects arbitrary
repositories so a client cannot use the server's credential against any
repository it names.

Mutating routes require the same PiChamber client authentication as other
write routes.

## 6. UI

### 6.1 Contract

Rework the dormant `GitHubAPI` in `packages/ui/src/lib/api/types.ts`:

- remove device-flow and multi-account members (`authStart`, `authComplete`,
  `authActivate`, `authDisconnect`, `authSetGhCliDisabled`);
- replace with `status()`, `scope(directory)`, and the list/detail/action
  methods matching §5.3;
- keep and adapt the existing PR/issue/check types where they fit.

Implement `RuntimeAPIs.github` in the web runtime factory
(`packages/web/src/api/index.ts`); desktop, hosted mobile, and Capacitor reuse
the same HTTP implementation through `runtimeFetch`.

### 6.2 Rail surfaces

Two new right-rail surfaces, **Pull requests** and **Issues**, registered in
`packages/ui/src/lib/surfaces/registry.ts` following the
`lib/surfaces/DOCUMENTATION.md` checklist.

- Add a new availability, `'github-repo'`: the surface is shown when the
  session directory's scope contains at least one GitHub repository. While
  scope is loading, the surfaces are hidden. If scope resolution fails, they
  are shown and render the failure, so an error doesn't make the feature look
  absent.
- Singleton surfaces: they remount on switch and restore list filters,
  selection, and scroll from their store.
- Header: repository label or picker (§4.3), acting account (`@login`,
  read-only), refresh.

### 6.3 Pull requests surface

**List**

- State tabs: Open / Closed / Merged / All.
- Involvement filter: All / Created by me / Review requested / Assigned.
- Search box with qualifier passthrough (`label:bug`, `author:x`), 250 ms
  debounce.
- Sort: recently updated (default), newest, oldest.
- Row: state/draft glyph, `#number`, title, `head → base`, author avatar,
  checks glyph, review decision glyph, diff stat, updated time, "linked to a
  session" marker.
- Cursor pagination with **Load more**. The last good page shows immediately
  from a snapshot while the fresh read loads.
- Empty states distinguish "no pull requests", "nothing matches these filters"
  (with **Clear filters**), and each `unavailable` reason (with the concrete
  fix, e.g. "Run `gh auth login` on the machine running PiChamber, then
  **Check again**").

**Detail** (opens in place with a back control; the panel width is shared
with other surfaces)

- Header: title (editable when permitted), state, draft badge, `head → base`,
  out-of-date warning with **Update branch**, checks rollup, mergeability,
  author, open on GitHub.
- Tabs:
  - **Overview**: description (markdown, editable when permitted), reviewers
    and verdicts, labels, checks list with per-check **Details** and **Send to
    agent**, top-level comments (newest/oldest toggle, older comments paged,
    bot comments collapsed), comment composer.
  - **Files**: changed files with the existing diff viewer
    (`PierreDiffViewer`), file tree, collapse per file, loaded in slices for
    large PRs. Review threads are anchored to lines; reply and
    resolve/unresolve work inline. Selecting lines lets you **Add to review**
    or **Send to agent**.
  - **Checks**: grouped by outcome, expandable to job steps and annotations
    (file:line links open in the Files surface), **Send failed checks to
    agent**, **Re-run failed jobs** (when permitted).
- Actions: Merge (merge/squash/rebase, per-repo remembered method), Ready for
  review, Convert to draft, Close, Reopen, Update branch. Actions the viewer
  lacks permission for are disabled with the reason. Merge, Close, and Update
  branch (rebase) need confirmation.
- Review: pending review with inline comments persisted as a local draft; submit as
  Comment / Approve / Request changes.
- **Check out**: into a new worktree (default) or the current checkout. Uses
  git only: fetch `refs/pull/<n>/head`, create a local branch, and work
  through the existing worktree service; it offers to start a session there.

### 6.4 Issues surface

- List: Open / Closed / All; filters: Assigned to me, Created by me,
  Mentioned; labels; search with qualifiers; same row, pagination and
  empty-state rules as PRs (glyph, `#number`, title, labels (max 2 + count),
  assignees, comment count, updated time).
- Detail: body (markdown), labels, assignees, milestone, linked PRs, comment
  thread, comment composer, Close (as completed / not planned) / Reopen, edit
  title/body.
- **New issue**: title, body, labels, assignees; applies the repository's
  issue templates when present.
- **Start session from issue**: choose current checkout or new worktree
  (branch `issue-<n>-<slug>`), then open a session whose first message is
  pre-filled (not auto-sent) with the issue context (§8).

### 6.5 Git surface additions

- Current-branch PR chip in the Git header: number, state, checks glyph;
  opens the PR in the Pull requests surface.
- **Create pull request** when the branch has no PR: base branch (default
  branch pre-selected; upstream when on a fork), title and body, draft toggle,
  **Generate** title/body from the branch diff using the existing
  commit-message model setting and the repository's PR template if present.
  Push first if the branch has no upstream, with the user's normal
  credentials.

### 6.6 Other surfaces

- **Session sidebar**: revive the stubbed `useGitHubPrStatusStore` so session
  and worktree rows show a compact PR badge (number + checks state) for their
  branch.
- **Header**: revive `DesktopGitHubControl` as a read-only account indicator
  (avatar, `@login`, "via GitHub CLI"). No switching.
- **Settings**: a GitHub section (in the existing Git settings page) showing
  gh installed/version, signed-in account per host, token scopes, missing
  scopes with the exact `gh auth refresh -s …` command, and **Check again**.
  It also explains that `git push` uses the user's normal git credentials.
- **Composer**: **Link issue / pull request** in the attach menu (picker with
  search, `#123`, or URL). The linked chips reuse the existing
  `application/vnd.github.issue-link` / `pull-request-link` attachment
  rendering.

### 6.7 Mobile

- **Capacitor shell**: add **PRs** and **Issues** tabs to the workspace
  drawer (`MobileWorkspaceTab`), each a list → detail stack with read access,
  comments, and state actions.
  - v1 PR detail on mobile shows Overview and Checks. Files/review on
    mobile is a follow-up.
- **Hosted mobile / narrow web**: the rail surfaces use the same list → detail
  stack at narrow widths.
- The difference from desktop is intentional and documented in both surface
  documentation files.

## 7. State and freshness (UI)

### 7.1 Stores

- `useGitHubStatusStore`: gh status per runtime; reset on runtime switch.
- `useGitHubScopeStore`: scope + selection per directory.
- `useGitHubPullRequestsStore` / `useGitHubIssuesStore`: list and detail
  entries keyed by `runtime + repo + filters` and `runtime + repo + number`.
  - Entries are last-known-first with background revalidation.
  - Stale responses are guarded by request generation.
  - A failed refresh keeps the previous data, marked stale with the error, and
    never replaces it with empty.
- Optimistic updates only for the user's own actions (state, labels,
  comments), with rollback on failure.

### 7.2 Refresh triggers

- Surface open, window focus/visibility, repository selection change, explicit
  refresh.
- After the user's own action: invalidate the affected entries, then re-read.
- After an agent turn ends in a session whose directory maps to a repository:
  invalidate that repository's current-branch PR status and open detail.
- Current-branch PR status (Git chip, sidebar badges):
  - after a branch change or push, retry at 2 s and 5 s to cover GitHub's
    delay;
  - otherwise open + checks pending: 1 min; open + settled: 5 min; no PR:
    5 min discovery;
  - no polling while the document is hidden.
- No fixed polling for lists; TTL + focus + explicit refresh is enough.

## 8. Agent integration

- **Context payloads** are built server-side (`context.js`) and attached to the
  composer as chips. The user reviews them before sending:
  - Issue: title, body, labels, state, recent comments.
  - PR: title, body, head/base, changed file list, optional diff, unresolved
    review threads.
  - Failed checks: check name, failing steps, annotations, log excerpt.
- **Budgets**: per-item and total character caps; truncation is marked
  explicitly.
- **Untrusted data framing**: every payload is wrapped as quoted external data
  with an instruction that it is not a command to follow.
- **Entry points**:
  - Start session from issue/PR.
  - Link issue/PR in the composer.
  - Send failed checks / Send to agent on a check.
  - Send review thread(s) to agent.
  - Send selected diff lines to agent.
- **Session ↔ PR/issue link**: linked references are recorded in session
  metadata so the session row shows them, and the PR/issue detail lists the
  linked sessions. A PR the user creates from a session's branch links
  automatically.
- No auto-send, and no starting a session on an untrusted PR branch without an
  explicit confirmation.

## 9. Security checklist

- Tokens:
  - in memory only;
  - never logged, returned, or embedded in errors;
  - `gh` output is never forwarded raw to clients.
- `execFile` with argument arrays only. Repository and number inputs are
  validated (`owner`/`repo` charset, positive integer numbers) before use in
  URLs or git refs.
- `repo` parameters are restricted to resolver-produced repositories (§5.3).
- Host allow-list per §3.3.
- Markdown from GitHub is rendered with the existing sanitized markdown
  pipeline; images from GitHub are loaded without credentials.
- Mutations require authenticated PiChamber clients. Destructive actions need
  confirmation in the UI and are idempotent-safe on retry, never auto-retried
  after an uncertain outcome.

## 10. Phases

Each phase ships independently, with its own tests and documentation.

**Phase 0: Retire git identity profiles** (§3.5)
- Remove the server, UI, and settings pieces.
- Keep the read-only commit-author line.
- Update the git module documentation and the settings search metadata.
- Run `bun run dead-code`.

**Phase 1: Foundation (read-only)**
- `gh` detection, credential pinning, `fetch` client with ETag and rate
  limits, error taxonomy.
- Repository scope resolver (containing, enclosing, nested, submodules,
  worktrees, forks) + `/scope`.
- `RuntimeAPIs.github`, status store, Settings GitHub section, header account
  indicator.
- Pull requests and Issues rail surfaces: lists and details (Overview; Files
  read-only; Checks), repository picker.
- Git header PR chip, sidebar PR badges.

**Phase 2: Actions**
- PR: create (with Generate), edit, merge/ready/draft/close/reopen/update
  branch, top-level comments.
- Issues: create, edit, close/reopen, comment, labels/assignees.
- Optimistic updates, confirmations, permission-aware disabling.

**Phase 3: Review**
- Inline review threads: reply, resolve, pending review with inline comments,
  submit verdict.
- Re-run failed jobs.
- Files: viewed ticks (GitHub's own viewed state).

**Phase 4: Agent integration**
- Context payloads, composer linking, start session from issue/PR (worktree
  option), send checks/threads/lines to agent, session ↔ PR/issue links,
  refresh after agent turns.

**Phase 5: Mobile**
- Capacitor drawer tabs, narrow-width stacks, parity documentation.

**Later (not planned yet)**
- GitHub Enterprise hosts.
- Sharing the repository picker with the Git surface.
- Per-repository accounts (only if users ask for them).
- Notifications for review requests and CI failures.

## 11. Validation

- Server unit tests (`packages/web/server/lib/github/*.test.js`):
  - remote parsing;
  - scope discovery (nested, enclosing, submodule, worktree, budget
    truncation) against temp repos;
  - token pinning across a simulated account switch;
  - fingerprinted cache keys;
  - ETag 304 replay;
  - rate-limit mapping;
  - each `unavailable` reason;
  - repository allow-list enforcement;
  - no token in any error/log path.
- `gh` is stubbed via a fake binary on PATH in tests; no network in unit
  tests.
- UI tests (`bun test --isolate`, self-contained):
  - stores (stale guards, failed refresh keeps data, optimistic rollback);
  - surface availability;
  - empty vs error rendering.
- `bun run test`, package type-check/lint, and `bun run dead-code` (new files
  and exports).
- Manual runtime checks per phase:
  - desktop and web against a real repository with gh signed in;
  - gh signed out;
  - gh missing;
  - a fork;
  - a directory with nested repositories;
  - a non-GitHub remote.
  - Capacitor for Phase 5.

## 12. Documentation to update

- New `packages/web/server/lib/github/DOCUMENTATION.md` (credential model,
  scope resolution, caching, error taxonomy, invariants).
- `packages/ui/src/lib/surfaces/DOCUMENTATION.md` (new surfaces, `github-repo`
  availability; remove "There is no Pull Request rail until that integration
  exists").
- `packages/ui/src/stores/DOCUMENTATION.md` (new stores).
- `packages/mobile/README.md` / apps documentation (drawer tabs, parity).
- Product docs in `packages/docs` (GitHub page: requirements, what works,
  troubleshooting).

## 13. Decisions

1. Two rail surfaces: **Pull requests** and **Issues**.
2. Native `fetch` against the GitHub REST and GraphQL APIs, authenticated with
   the token pinned from `gh auth token`. No new dependency.
3. Nested repository discovery uses the limits in §4.1. The Git surface keeps
   its directory scoping in v1; sharing the picker with it comes later.
4. PR checkout defaults to a new worktree.
5. Phase order as listed in §10.
6. Git identity profiles are removed completely (§3.5), including the silent
   default auto-apply and clone-time identity.
