# Tasks

The working backlog. Agents pick the **first `ready` task whose dependencies are done**, move it to
`in-progress` (with branch name) in the same PR that implements it, and to `done` (with PR number and
verification evidence) when CI is green and `verify:preview` passes. Order within a milestone is priority.

Status: `ready` · `in-progress` · `in-review` (PR open) · `done` · `blocked` (reason) · `needs-approval` (owner decision).
Risk: **low** (UI/docs/tests), **medium** (services, caching, perf), **high** (data paths, security, config).
Every task's acceptance criteria implicitly include: lint, typecheck, `npm test`, `npm run build`, relevant
e2e suites, green CI, `verify:preview` 33+/all pass, docs updated (this file + PROJECT_STATUS.md).

## Milestone 1 — Engineering foundation

### T-101 Project source-of-truth docs — `done` (PR #24, merged 2026-11-25)
PRODUCT, ROADMAP, TASKS, ARCHITECTURE (current system), DECISIONS, RELEASE_CHECKLIST, PROJECT_STATUS; agent
definitions in `.claude/agents/`; staging merge gate. Risk: low (but touches agent rules → owner merges).

### T-102 Preview performance baseline — `done` (PR #27, merged 2026-11-25; baseline in PROJECT_STATUS.md)
Extend `verify:preview` to record cold and warm response times (server timing + total) for `/`, each level's
`/players`, one profile per level, `/trends`, into the JSON report; add a `--timings` summary.
AC: report contains per-path cold/warm ms; unit test for the timing summary; numbers recorded in
docs/PROJECT_STATUS.md for staging. Risk: low. Depends: —.

### T-103 Remove dead demo-era code — `done` (PR #28, merged 2026-11-25)
`src/services/prospects.ts`, `src/services/discovery.ts`, `src/data/demo.ts` users: confirm no route imports
them (build + grep), delete or move to test fixtures, keep the opt-in seed working or retire it explicitly.
AC: no user-facing import of demo data; tests updated (not weakened); bundle unchanged or smaller. Risk: low.

### T-104 Stale doc cleanup — `done` (PR #29, merged 2026-11-25)
README "nothing is deployed", VERCEL.md header, REDESIGN/VISUAL-DESIGN (mark historical or fold into
DECISIONS), Lightsail docs labelled "dormant alternative" consistently (DECISIONS D-003). AC: no doc
contradicts PROJECT_STATUS.md. Risk: low.

### T-105 Guarded staging merges — `done` (PR #30, merged 2026-11-25; enabled: T-106 rulesets in effect + the owner's allow rule)
`npm run merge:staging -- --pr N --sha S`: runs the gate, merges only on `ready` into `staging` with the sha pinned, verifies staging
afterwards and halts automatic merges on failure; 5/day limit; audit log. AC: unit tests for every refusal path;
bypass routes denied in `.claude/settings.json` (tested). Enabling: owner (see AUTONOMOUS-WORKFLOW §6a).

### T-106 Branch protection for `main` and `staging` — `done` (owner, 2026-11-25: rulesets `staging` and `main`, active, no bypass)
Require PRs and the CI checks listed in `scripts/staging-gate-support.ts`; no force pushes. GitHub setting: owner.

## Milestone 2 — Discovery and comparison

### T-201 Player comparison page — `done` (PR #25, merged 2026-11-25)
`/compare?level=<id>&ids=<uuid,uuid[,…]>` (2–4 players, same role, same level). Side-by-side season line,
selected window line, within-level percentile fingerprint, Momentum with confidence, sample sizes; "add to
compare" from profiles and directory rows; invalid/mixed ids give a clear notice, unknown ids 404-free notice.
AC: server-rendered, works without JS, CDN-cacheable like /players, a11y test passes, unit tests for the
query parsing and view model, nav e2e covers add → compare. No cross-level blending. Risk: low/medium.

### T-202 Watchlist (per browser) — `done` (PR #31, merged 2026-11-25)
Star button on profiles/directory rows, `/watchlist` page listing starred players with latest level line and
Momentum. localStorage only (wrapped in try/catch, empty-state works), no server state, no tracking.
AC: works with storage blocked (graceful), a11y passes, e2e covers star → list → unstar. Risk: low. Depends: —.

### T-203 Directory depth — `done` (PR #26, merged 2026-11-25; follow-ups: notice for dropped out-of-range values, blur+sort double navigation)
ISO and BABIP columns (hitters), age filter (min/max), stat-threshold filter (e.g. OPS ≥, K% ≤) for the
sortable columns, preset column groups. AC: URL state round-trips; server-side filtering; tests for parsing,
bounds and formulas (hand-computed fixtures); BABIP = (H−HR)/(AB−SO−HR+SF). Risk: low.

### T-204 Organization and team pages — `in-review` (branch `claude/t-204-org-pages`)
`/orgs/[slug]` (players by affiliate and level) and team context; replace the filtered-directory links.
AC: data from the snapshot only; 404 for unknown; cacheable; tests. Risk: medium. Depends: —.
Built: `/orgs` (index with players per level) and `/orgs/[slug]` (abbreviation slug or UUID; same-slug clash lists
both instead of guessing; unknown → 404): per level (ladder order) and affiliate, hitters and pitchers with season
line and 14D Momentum, the directory's own rows (no new statistics). Organization links (profiles, home, trends,
directory Org column) open it; team links still open the team-filtered directory, linked from each affiliate.
"Orgs" in the header. **Not yet CDN-cached:** that needs `/orgs` and `/orgs/:slug` in `CDN_CACHED_ROUTES`
(src/lib/cdn-cache.ts, owner-merged) — follow-up T-204b.

### T-204b CDN-cache the organization pages — `ready` (owner merges: src/lib/cdn-cache.ts)
Add `/orgs` and `/orgs/:slug` to `CDN_CACHED_ROUTES` (+ the vercel.test.ts list and the cdn-cache e2e), and point the
retired `/organizations/:path*` redirect (next.config.ts) at `/orgs`. Risk: low. Depends: T-204.

### T-205 Typeahead search — `done` (PR #38, guarded merge 2026-11-26, staging 04c446b verified 33/33)
Client island on the header search using a compact per-level name index. AC: <50 kB index, keyboard
accessible combobox, no request per keystroke beyond the index. Risk: medium.
Built: `/search/names?level=` (route handler, CDN header on 200 only) serves `{v, level, teams, players: [key, name, pos, team]}`
for every player with a line at the level; `key` is the shortest unique UUID hex prefix (≥ 10) because full UUIDs alone
would put the largest level (~2,000 players) over 50 kB gzipped. Test budget: 2,400 players → 44.6 kB gzipped (92.5 kB raw).
Picking opens `/search/player?level=&id=&q=`, which resolves the key against the same level and redirects to the profile; a key
that does not resolve (older deployment's index) falls back to `/players?level=&q=`. Header input is an ARIA 1.2 combobox
(listbox, aria-activedescendant, ArrowUp/Down, Enter, Escape, live count); index fetched on first focus (URL `?level=` or every
level), cached per page session; matching is local (accent/case-insensitive: name prefix > word prefix > substring, max 8).
Without JavaScript the form is unchanged (GET /players?q=). Tests: scripts/typeahead.test.ts, navigation e2e (one index request,
none per keystroke, keyboard pick → profile, Escape, plain submit; index JSON + redirect fallbacks).
Follow-up: the fallback directory search opens the hitters list, so a pitcher's stale key lands on an empty hitter search.

### T-206 Compare entry point from the directory — `done` (PR #33, guarded merge 2026-11-26, staging 65d655e verified 33/33)
A "compare" checkbox/link per row on /players building a /compare URL for the current level. AC: works without JS (form GET), max 4, e2e. Risk: low.
Built: "Cmp" checkbox column (single level only; "All levels" shows a pointer instead) and a GET form to `/compare`
(`/compare` now reads repeated `ids` fields as one list, still capped). With JS: client navigation, picks survive
paging and filters, clear on level/role change, 5th box disabled. Without JS: plain GET form, fully usable since T-207.

### T-207 Pages work without JavaScript — `done` (PR #34, guarded merge 2026-11-26, staging 5361a4f verified 33/33; owner-approved)
`/`, `/players`, `/trends`, `/data` and the header score strip rendered behind streamed `<Suspense>` boundaries, so with
JavaScript off their content stayed in `<div hidden id="S:…">` and only "Loading…" showed. Found in T-206. Fix: render in
place (no boundary; client navigations keep the old page and show the navigation hint). AC: e2e with JavaScript disabled
(content visible, no hidden streamed blocks; directory Apply search and compare picks by real clicks). Risk: low–medium
(first-byte now waits for data; pages are CDN-cached). `/analytics/models` (development only) keeps its boundary.

## Milestone 3 — Performance and reliability

### T-301 Per-snapshot player index — `ready`
Replace `playerLevels` full scans with an index built once per snapshot. AC: profile render time measured
before/after (T-102 method), identical output (tests), memory not worse. Risk: medium.

### T-302 DB integration suites in CI — `ready` (owner merges: touches .github)
Postgres service container in CI running the `*.integration.ts` suites against a disposable database.
AC: suites run green in CI; no secrets needed. Risk: medium.

### T-303 Verify Vercel CDN and identity behavior — `in-review` (branch `claude/t-303-vercel-checks`; check 7 inconclusive)
VERCEL.md Preview checks 3, 7, 8 via `vercel curl`/bypass: CDN cache headers honored, forged
`x-vercel-forwarded-for` overwritten, limiter on cache hits. AC: results recorded in VERCEL.md. Risk: low.
Done 2026-11-26 (VERCEL.md "Results of checks 3, 7 and 8"): CDN HIT on second request for pages, profiles and 404s; never
for RSC/`_rsc`; per-deployment scope; Deployment Protection before the cache. Check 7: 400 honest, 400 forged and 800 faster
(64 concurrent) requests all 200 with no 429 — spread over many instances, so identity overwrite and limiter-on-cache-hits
stay unanswered. **Owner decision:** accept the per-instance limiter on Vercel as documented, or add a diagnostic (limiter key /
instance id header on a debug route) to answer it.

### T-304 Mobile + accessibility pass on the Preview — `ready`
Run `scripts/ops/a11y-scan.ts` against the Preview at 390 px and 1366 px; fix findings. Risk: low.

### T-305 Momentum golden test platform note — `done` (PR #32, merged 2026-11-25; no assertion changed)
The golden test fails on macOS arm64 (1 of 2638: `Math.tanh` last-bit difference) and passes on Linux/CI.
Document Linux as the canonical platform in the test and ANALYTICS.md; optionally add `npm run test:golden`
guidance. Never regenerate or loosen. Risk: low.

## Milestone 4 — Analytics depth

### T-401 Age relative to level — `needs-approval`
Proposal in DECISIONS.md: level median age from the snapshot, shown as "+/- years vs level median".
### T-402 Breakout detection methodology — `needs-approval` (proposal only)
### T-403 Prospect Grade methodology — `needs-approval` (proposal only)
### T-404 Similarity methodology — `needs-approval` (proposal only)

## Milestone 5–6 — Data breadth and launch (owner-gated)

### T-501 Prior seasons ingestion — `needs-approval` (live ingestion + Neon capacity)
### T-502 In-season automatic refresh — `needs-approval` (Vercel deploy hook + scheduler secret)
### T-601 Data licensing — `blocked` (legal decision; hard launch blocker)
### T-602 Privacy notice + retention, error monitoring, production verification — `blocked` on T-601

## Known bugs / debt (tracked here, fix through tasks above)

- Momentum golden test macOS-only failure (CI/Linux canonical, documented: T-305).
- `verify:preview --sha <short sha>` waits until `--wait-minutes` runs out (deployment lookup matches the full sha only);
  pass the full 40-character sha. `merge:staging` already does. Fix: resolve or refuse short shas (trusted file: owner merges).
- `scripts/site-data.test.ts` "watchdog: a connection that keeps trickling…" is timing-sensitive: failed once in a loaded local full `npm test` run (2026-11-25), passed 3/3 alone. Watch in CI; harden its timing margins if it recurs (never loosen what it asserts).
- `playerLevels` full scan per profile (T-301).
- Snapshot loaders have no ORDER BY (row order not deterministic; output equality relies on later sorting) — investigate under T-301.
- `staleTimes` experimental, prefetch classification depends on Next internals (VERCEL.md M1) — watch on Next upgrades.
- Unused demo-era tables (`news_items`, `highlights`, `prospect_scores`, `conferences`) — keep until a migration is approved.
- Deprecated transitive dev deps (`@esbuild-kit/*` via drizzle-kit) — update when upstream fixes.
