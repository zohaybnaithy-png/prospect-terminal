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

### T-204 Organization and team pages — `done` (PR #36, guarded merge 2026-11-26; CDN caching: T-204b)
`/orgs/[slug]` (players by affiliate and level) and team context; replace the filtered-directory links.
AC: data from the snapshot only; 404 for unknown; cacheable; tests. Risk: medium. Depends: —.
Built: `/orgs` (index with players per level) and `/orgs/[slug]` (abbreviation slug or UUID; same-slug clash lists
both instead of guessing; unknown → 404): per level (ladder order) and affiliate, hitters and pitchers with season
line and 14D Momentum, the directory's own rows (no new statistics). Organization links (profiles, home, trends,
directory Org column) open it; team links still open the team-filtered directory, linked from each affiliate.
"Orgs" in the header. **Not yet CDN-cached:** that needs `/orgs` and `/orgs/:slug` in `CDN_CACHED_ROUTES`
(src/lib/cdn-cache.ts, owner-merged) — follow-up T-204b.

### T-204b CDN-cache the organization pages — `done` (PR #37, owner-merged 2026-11-26; staging 8d4bcd5 verified 33/33)
Add `/orgs` and `/orgs/:slug` to `CDN_CACHED_ROUTES` (+ the vercel.test.ts list and the cdn-cache e2e), and point the
retired `/organizations/:path*` redirect (next.config.ts) at `/orgs`. Risk: low. Depends: T-204.
Built: both routes in `CDN_CACHED_ROUTES` (unit list + matcher cases incl. `/orgs/x/y` not cached); cdn-cache e2e covers `/orgs`,
an org page (+ query), an unknown org's cached 404, and `/organizations/x` → 307 to `/orgs`, uncached. VERCEL.md route list updated.

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

### T-301 Profile season row without building every row — `in-review` (branch `claude/t-301-profile-rows`; re-scope approved by the owner 2026-11-26, D-018)
Replace `playerLevels` full scans with an index built once per snapshot. AC: profile render time measured
before/after (T-102 method), identical output (tests), memory not worse. Risk: medium.
Measured (nightly 2026-11-26, local, `profilePages` from src/services/competition/profile.ts over five fictional full-size
levels from `scaleSnapshot`, 46,530 lines per MiLB level, cold/warm ms per profile): `playerLevels` 0.8–1.2 / 0.6–0.7,
`playerProfile` 9.3–12.2 / 9.2–11.3, `playerAnalyticsView` 13.4–18.4 / 7.1–9.5. Across 468 profiles `playerLevels` averaged
0.52 ms. A per-snapshot index would save under 1 ms of a 0.2–1.1 s first render (T-102) and add per-player arrays to every
cached level, which breaks "memory not worse", so it was not built.
**Approved re-scope (D-018):** T-301 to `playerProfile` (src/services/afl/read-model.ts), which calls
`buildPlayerRows(s, "season")` for every player on each profile render just to `find` one row: about 9–11 ms per profile.
Reusing the memoized/precomputed season rows (`levelDirectoryRows`) or building only that player's row should remove most
of it; AC as before (T-102 timings, identical output, memory not worse).
Built: `playerProfile` builds only that player's row (context index over the player's own stints and lines; season
aggregates reused from the profile's window pass). Same full-size fixture level (46,530 lines, 112 profiles): **10.24 →
1.20 ms per profile**. Identical output: new test compares the row with `buildPlayerRows(s, "season")` for every player in six
snapshots (roster, game-lines-only and no-team players; tied roster rows). No new caches, so memory is not worse.

### T-302 DB integration suites in CI — `in-review` (branch `claude/t-302-db-ci`; owner merges: touches .github)
Built: CI job "Database integration suites": `postgres:17` service container (trust auth, no secrets), one fresh migrated
database per suite under the names the suites require, then all eight `test:*:db` suites. Not yet a required check:
after it is green, the owner can add it to the `staging`/`main` rulesets and `scripts/staging-gate-support.ts`.
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

### T-304 Mobile + accessibility pass on the Preview — `in-review` (branch `claude/t-304-a11y`)
Run `scripts/ops/a11y-scan.ts` against the Preview at 390 px and 1366 px; fix findings. Risk: low.
Done against a local production build of a fictional snapshot (the scan script cannot send the Preview bypass header;
structure and CSS are identical): 32 pages/states × 390 and 1366 px, incl. /orgs, /orgs/[slug], /compare, /watchlist,
/search/player. Found one rule, axe `link-in-text-block` (serious): team links in home trending rows and the "Players"
link in the empty /compare steps were told apart by colour only → now underlined like other in-text links (regression
test in accessibility.test.ts). Rescan: 0 violations. No horizontal page scroll at 390 or 768 px on 12 main pages.
Follow-up (optional): let the scan send the bypass header to the Preview's own host so it can run on real data.

### T-305 Momentum golden test platform note — `done` (PR #32, merged 2026-11-25; no assertion changed)
The golden test fails on macOS arm64 (1 of 2638: `Math.tanh` last-bit difference) and passes on Linux/CI.
Document Linux as the canonical platform in the test and ANALYTICS.md; optionally add `npm run test:golden`
guidance. Never regenerate or loosen. Risk: low.

## Milestone 4 — Analytics depth

### T-401 Age relative to level — `done` (PR #44, merged 2026-11-26; owner-approved, D-020)
Proposal in DECISIONS.md: level median age from the snapshot, shown as "+/- years vs level median".
Built: `src/services/players/level-age.ts` (definition in D-020). Directory column "±Lvl" (sortable, key `agerel`) and a
"vs <level> median" item on the profile; /data glossary entry. Tests: hand-computed decimal ages, median odd/even, the
population rule (lines + birth date), the 20-player minimum, sign/rounding/formatting, directory rows and sort.
The value is added in `directoryRows`, not `levelDirectoryRows`, so the memoized/precomputed rows and the Momentum
golden file (which records them) are unchanged — the golden file was not regenerated (D-015).
### T-402 Breakout detection methodology — `done` (approved as proposed 2026-11-26, D-021); validation → T-405
Proposal: docs/BREAKOUT-METHOD.md. Per-level, skill-rate (K%, BB%, ISO / K%, BB%) step-change flag with shrinkage,
permutation-calibrated false-discovery control, a level-standing bar and persistence. Includes an offline validation plan
on the 2026 snapshot (reliability, null calibration, holdout retention vs matched controls and naive baselines, churn)
and success criteria. No code until the owner approves §9 of the document; the first deliverable after approval is the
validation script and report only.
### T-405 Breakout validation (offline) — `done` (run as approved; failed at every level, D-023; report docs/reports/breakout-validation-2026.md)
Implement the pure detector (`src/analytics/breakout/`) and `npm run analytics:breakout-validate` per
docs/BREAKOUT-METHOD.md §6 on the 2026 snapshot; report against §7. No user-facing feature, no new data.
Built: detector, validation, report, `--synthetic`, 13 tests. Synthetic data shows the approved detector is precise
(null ≤ 0.02 flags/date, every flag a planted change) but underpowered and unstable (§10). Needs from the owner:
(1) the local snapshot (`npm run -s snapshot:export` with the read-only `DATABASE_URL`; the agent has no database
credential), then `npm run -s analytics:breakout-validate > report.md`; (2) decided 2026-11-27: run as approved (D-022).
### T-403 Prospect Grade methodology — `needs-approval` (proposal written, awaiting owner)
Proposal: docs/GRADE-METHOD.md. A statistical Grade (expected MLB value over six seasons, 20–80 scale) can only be
validated against past cohorts' outcomes, so it depends on ingesting past MiLB seasons and MLB careers (T-501) and on
licensing for public display (T-601). Two-stage regularized regression (P(MLB) × value given MLB), forward-in-time
validation against level/age/OPS baselines. No code or ingestion until the owner approves §9.
### T-404 Similarity methodology — `done` (owner-approved as proposed 2026-11-27, D-024)
Method: docs/SIMILARITY-METHOD.md. Same-level, same-role, same-season profile similarity (shrunk, reliability-weighted
z-scores incl. age vs level; weighted Euclidean; top 5). Descriptive, not a projection.

### T-406 Similarity validation — `done` (D-025; branch `claude/t-404-similarity-method`)
Offline validation per SIMILARITY-METHOD.md §6–§7, nothing shown on the site. Acceptance: pure module
`src/analytics/similarity/`, CLI `scripts/similarity-validate.ts` reading `.data-snapshot/` only, unit tests, the
synthetic check (archetypes pass, noise fails) before the real-data run, implementation choices committed (§10) before
the real-data run, report `docs/reports/similarity-validation-2026.md`, random-sample face-validity review by the
baseball-analyst agent, verdict per level × role in §11. Building the profile UI is a separate task, only for level/roles
that pass and only after the owner approves showing it.

### T-407 Similarity next step — `done` ((a) D-026 rule, re-validated D-027; (b) display approved 2026-11-27, D-028 → T-408)
(a) Hitter position-group rule approved 2026-11-27 (D-026); re-validated, hitters pass at every level (D-027, SIMILARITY-METHOD.md §12).
(b) Approve showing hitter and pitcher lists on the profile as "similar so far this season" (browsing aid, no predictive
claim), with the display rules 2–4 of §11 and a score floor fixed in advance (§12). No UI work before (b).

### T-408 Similar players on the profile — `done` (PR #48, merged 2026-11-27; D-028)
Profile section "Similar at <level> so far this season" per role (both for two-way players): up to 5 players with
score ≥ 70, position, Bats/Throws, sample (flag † at ≥ 3× difference), score, observed rates, closest/furthest
dimensions (furthest by weighted contribution), a Compare link; honest states for AFL, < 100 PA/BF, small position
group, no close match. `/data#similarity` explains the method and that it is a browsing aid, not a projection.
Acceptance: unit tests, lint/typecheck/test/build, CI, verify:preview.

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
