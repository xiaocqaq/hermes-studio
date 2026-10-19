# Fork customizations (must survive upstream merges)

This repository is a long-lived fork of `EKKOLearnAI/hermes-studio` that ships a
production deployment at <https://hs.xlingo.fun>. Upstream merges are frequent
and large (0.7.21 → 0.7.37 alone was 212 commits), so the customizations below
are easy to lose in a conflict resolution.

**Rule for any agent merging upstream:** read this file first, resolve conflicts
so every item here still holds, then run the verification snippet at the bottom.
If a conflict tempts you to drop one of these, do not — re-implement the fork
intent on top of the upstream shape instead.

Every entry names the files that carry it. When upstream rewrites a file, port
the behaviour, not the diff.

## 1. Branding stays "Hermes Studio"

Upstream renamed the product to "Ekko Studio". This fork keeps the original
brand everywhere it is user-visible.

- `packages/client/index.html` — `<title>Hermes Studio</title>` and
  `<meta name="apple-mobile-web-app-title" content="Hermes Studio" />`
- `packages/client/public/manifest.webmanifest` — `"name": "Hermes Studio"`
- `packages/client/src/views/hermes/ChatView.vue` — `const productTitle = 'Hermes Studio'`
- `packages/client/src/main.ts` — crash overlay title
  `'Hermes Studio encountered an unexpected interface error'`
- `packages/client/src/utils/chat-agent-avatar.ts` — pending sessions fall back
  to the Hermes avatar, not Ekko
- `packages/client/src/i18n/locales/*.ts` — **every** locale's `login.title` is
  `'Hermes Studio'`. Upstream adds new locales periodically (Turkish arrived in
  0.7.37); a new locale ships with `'Ekko Studio'` and must be fixed. Grep the
  locale folder rather than trusting a fixed list.

Note: other `Ekko Studio` strings inside locale files are upstream body copy
(desktop permission prompts, provider names, download pages). Do **not** blanket
replace them; only `login.title` is the fork's brand surface.

## 2. No advertising / partner surfaces

The "remove ad buttons" change (`70a30b1b`) stripped every outbound marketing
entry from the navigation.

Must **not** appear in `packages/client/src/components/layout/PageSidebarNav.vue`
nor in `packages/client/src/components/layout/StudioNavigationRail.vue`:

| Entry | i18n key | Why |
| --- | --- | --- |
| Device connections | `sidebar.connections` | product surface this deployment does not use |
| API relay / AK partner | `sidebar.apiRelay` | was an affiliate link (`apikey.fan`) |
| Group chat | `sidebar.groupChat` | hidden from navigation on purpose |
| Workflow | `sidebar.workflow` | hidden from navigation on purpose |

Also forbidden: the literal `apikey.fun` in client source, and the
`relay-logo.png` rail item.

The routes themselves (`hermes.connections`, `hermes.apiRelay`,
`hermes.groupChat`, `hermes.workflow`) stay registered so a bookmarked URL still
works — only the navigation entry is removed.

`StudioNavigationRail.vue` was introduced by upstream in 0.7.37 and arrived
pre-populated with all four entries; it is the component most likely to
reintroduce them. It is gated by `showNavigationRail` in
`packages/client/src/App.vue`, so it only shows on wide viewports — a desktop
screenshot is the fastest way to catch a regression.

`PageSidebarNav.vue` also must not ship the default-credentials hint: the fork
deleted `.login-default-hint` and `login.defaultCredentialsHint` from
`packages/client/src/views/LoginView.vue`.

## 3. Navigation additions

- `sidebar.journey` (学习轨迹) is a fork navigation entry, present in the page
  sidebar, the navigation rail and `packages/client/src/components/layout/HermesConfigSidebar.vue`.
  Route: `packages/client/src/router/index.ts` → `path: '/hermes/journey'`,
  `name: 'hermes.journey'`.
- `sidebar.jobs` / `sidebar.kanban` were **retired** (replaced by journey in
  commit `5aa9eb59`). Do not resurrect them; the i18n keys were removed from
  every locale except where the page body still needs them.
- The studio announcement prompt stays disabled — `StudioAnnouncementPrompt`
  must not be imported or rendered by `packages/client/src/App.vue`.
- Version-update UI is intentionally absent: no `updateAvailable` /
  `clientOutdated` / `updateVersion` / `reloadClientVersion` buttons in
  `packages/client/src/components/layout/AppSidebar.vue` or
  `PageSidebarFooter.vue`. Upgrades are manual.

## 4. Local message cache (large fork feature)

Switching sessions renders from IndexedDB instead of refetching, then syncs only
the tail.

- `packages/client/src/utils/hermes/message-cache.ts` — whole module
  (`CACHE_TTL_MS`, `CACHE_SCHEMA_VERSION`, `CACHE_MAX_SESSIONS`, `cacheKey`,
  `isMessageCacheAvailable`, `readCachedSession`, `writeCachedSession`,
  `deleteCachedSession`, `clearMessageCache`, `pruneMessageCache`).
- `packages/client/src/stores/hermes/chat.ts` — `restoreSwitchFromCache`
  (switch fast path), `syncSessionTail`, `markCacheBaseline`, `persistSessionCache`,
  `resumeSessionSnapshot`, and the visibility-change handler that prefers
  `syncSessionTail` over a full replay.

Upstream keeps rewriting this store, so the fork helpers must be re-inserted into
the new control flow rather than replacing it. Typical merge shape: keep the
upstream `let loaded = false` / search-pagination loop, then append the fork
cache-baseline block after it.

## 5. Ekko tool execution timeout

`packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run.ts`
must pass `timeoutMs: resolveToolExecutionTimeoutMs(agent)` into
`toolContext`, **not** a hardcoded `120_000`.

`TerminalExecTool.execute` resolves its timeout as
`input.timeoutMs ?? context.timeoutMs ?? this.timeoutMs`, so a hardcoded context
value silently overrides the Ekko config and kills long image-generation runs
(`gpt-image-2` routinely needs minutes). `resolveToolExecutionTimeoutMs` reads
`agent.readConfig().tools.executionTimeoutMs` and falls back to 120 s.

Production sets `tools.executionTimeoutMs` to 300000 in
`/root/.hermes-web-ui/.ekko/config/config.json`.

## 6. Browser session memory reclamation

Long-running Chrome sessions used to exhaust the box (3.7 GB RAM, earlyoom at
18 %). The fork closes browser sessions aggressively:

- `packages/ekko-agent/src/tools/browser.ts` — `closeAllBrowserSessions`
- `packages/ekko-agent/src/bootstrap/lifecycle.ts`
- `packages/server/src/modules/studio/services/chat-run/chat-agent-runtime-adapter.ts`
- `packages/server/src/modules/studio/public/chat-agent-runtime.ts` —
  `closeChatEkkoBrowserSession`
- `packages/server/src/modules/studio/sockets/chat-run.ts` — `releaseBrowserSession`

## 7. OpenCode Free provider is hidden

`packages/client/src/api/hermes/system.ts` exports
`HIDDEN_MODEL_PROVIDERS = new Set(['opencode-free'])` and
`stripHiddenProviders(res)`, applied in `fetchAvailableModels` and
`fetchAvailableModelsForProfile`. Tests live in
`tests/client/system-available-models-hide.test.ts`.

## 8. `POST /api/studio/update` requires a super admin

`packages/server/src/modules/studio/routes/update.ts` registers the route as
`updateRoutes.post('/api/studio/update', requireSuperAdmin, ctrl.handleUpdate)`.

This is a security fix, not a preference: the endpoint runs
`npm i -g <pkg>@latest` and restarts the service. Upstream shipped it with no
guard while every sibling preview route required a super admin, and on
2026-10-03 that let any logged-in user upgrade the production install. Keep the
guard **in source** — a runtime patch against the minified bundle silently
breaks whenever the bundler renames identifiers (see
`scripts/ops/patch-update-guard.sh`, which now derives the guard identifier from
the neighbouring preview route instead of hardcoding it).

Regression tests: `tests/server/update-route-guard.test.ts`.

## 9. Ops scripts

`scripts/ops/` holds the production maintenance tooling and `scripts/deploy-frontend.sh`
the frontend cutover. Both are fork-only; upstream has no equivalent. Keep them
when merging (`scripts/` rarely conflicts, but do check).

## 10. Line endings for Node ESM scripts

`.gitattributes` pins `*.mjs` and `*.cjs` to `text eol=lf`. A CRLF checkout puts
a stray `\r` at the end of the shebang line in
`scripts/server-module-boundaries.mjs`, and Vitest then fails the whole module
with `SyntaxError: Invalid or unexpected token` on Windows. Do not remove those
rules.

---

## Verification snippet

Run from the repository root after resolving a merge. Every line must print the
expected count; a `0` on any of them means a fork customization was lost.

```bash
# Branding
grep -c 'Hermes Studio' packages/client/index.html                 # 2
grep -rc "title: 'Hermes Studio'" packages/client/src/i18n/locales/ | grep -v ':0' | wc -l
#   ^ must equal the number of locale files in that directory

# Ad / partner surfaces must be gone
grep -c 'sidebar\.connections\|sidebar\.apiRelay\|apikey\.fun' \
  packages/client/src/components/layout/PageSidebarNav.vue \
  packages/client/src/components/layout/StudioNavigationRail.vue   # 0 for each
grep -c 'groupChat\|workflow' \
  packages/client/src/components/layout/StudioNavigationRail.vue   # 0

# Fork features present
grep -c 'syncSessionTail' packages/client/src/stores/hermes/chat.ts                    # > 0
grep -c 'resolveToolExecutionTimeoutMs' \
  packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run.ts        # 2
grep -c 'closeAllBrowserSessions' packages/ekko-agent/src/tools/browser.ts             # 1
grep -c 'stripHiddenProviders' packages/client/src/api/hermes/system.ts                # 3
grep -c 'requireSuperAdmin' packages/server/src/modules/studio/routes/update.ts        # 8
test -f packages/client/src/utils/hermes/message-cache.ts && echo ok                   # ok
test -f scripts/ops/patch-update-guard.sh && echo ok                                   # ok

# Navigation
grep -c 'openJourney' packages/client/src/components/layout/PageSidebarNav.vue          # > 0
grep -c 'StudioAnnouncementPrompt' packages/client/src/App.vue                          # 0
```

Then run the targeted suites:

```bash
npx vitest run tests/client/device-connections-permissions.test.ts \
  tests/client/login-view.test.ts \
  tests/client/i18n-coverage.test.ts \
  tests/client/chat-store-message-cache.test.ts \
  tests/server/update-route-guard.test.ts
```

A green run here plus `npm run harness:check` is the minimum bar before
deploying a merge.
