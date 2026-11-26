# Project status

Last updated: 2026-11-25. Read this first, then docs/TASKS.md.

## Current state
- `staging` = `5361a4f` (PRs #22–#34 merged: through T-104 docs, T-105 guarded merge, T-202 watchlist, T-206 directory compare picks, T-207 pages without JavaScript, T-305 golden note). `main` = `edc0084`, untouched.
- `staging` Preview `dpl_3awSNJ1y9h8bJEDoj9bpuZSMT5Nb` passes `verify:preview` 33/33: snapshot mode, views on,
  5 levels, snapshot `7efabf4a38dd`, Deployment Protection on. (Earlier staging builds used snapshot `3aa112749316`;
  the snapshot id follows the data the build exports.)
- Local: lint, typecheck, build pass; `npm test` all pass except the Momentum golden on macOS only (Math.tanh; CI/Linux passes; T-305).
- Production: Vercel Production deployment of `main` (`edc0084`, 2026-11-12), behind Deployment Protection, no public domain. Not a public launch (licensing, T-601).
- Data: 2026 regular season, all four MiLB levels + AFL, backfilled to the Neon test branch on 2026-11-07 (owner-approved); each Vercel build exports a read-only snapshot from the database configured for its environment (not changed by agents). Ingestion is otherwise off.
- Tooling: `gh` and `vercel` in `~/.local/bin`, both logged in (see docs/AUTONOMOUS-WORKFLOW.md §2 to recover).
- `npm run gate:staging` and `npm run merge:staging` are on `origin/staging`. Branch rulesets `staging` and `main` are in effect (PR required, 5 required checks, no force push or deletion, no bypass).
- In review: T-204b CDN caching of the organization pages (owner merges: touches cdn-cache.ts/next.config.ts). T-401 age vs level (D-020).

## Performance baseline (T-102, staging `dpl_3aC7fLEKfwyF3kgo1Q27hVteADww`, 2026-11-25)
Total ms from this Mac to the Preview, via `verify:preview --timings` (first request / warm median of 3).
The first request ran on an already-warm instance, so "first" mostly measures a CDN miss, not a cold start.

| Path | first | first cache | warm p50 |
|---|---:|---|---:|
| `/` | 96 | HIT | 106 |
| `/players?level=*` (aaa, aa, high-a, single-a, afl) | 93–121 | HIT | 97–111 |
| profile, aaa | 1055 | MISS | 97 |
| profile, aa | 796 | MISS | 112 |
| profile, high-a | 457 | MISS | 105 |
| profile, single-a | 604 | MISS | 103 |
| profile, afl | 206 | MISS | 107 |
| `/trends?level=*` | 219–334 (afl 150) | MISS | 102–110 |

Reading: directory pages are CDN hits; a profile's first render costs 0.2–1.1 s (larger levels cost more) and
then serves from the CDN at ~100 ms. Use these as the "before" numbers for T-103 and later performance work.

## Recent work
- 2026-11-26 (nightly): T-204 merged (#36). T-204b: `/orgs` and `/orgs/:slug` CDN-cached; `/organizations/*` now redirects to `/orgs`.
- 2026-11-26 (nightly): T-301 measured instead of built — `playerLevels` is ~0.5–1 ms per profile, `playerProfile` ~10 ms (rebuilds every player's season row); re-scope proposed in TASKS.md (needs-approval).
- 2026-11-26 (nightly): PR #38 (T-205 header typeahead: per-level name index with short keys + `/search/player` resolver; keyboard combobox) merged by `npm run merge:staging`, staging `04c446b` verified 33/33 (`dpl_HZUgATtvpzhhnK5yb27ApFfb14Ji`).
- 2026-11-26: PR #34 (T-207) merged by `npm run merge:staging`, staging `5361a4f` verified 33/33 (`dpl_5io3Xh6kvvHVLarSAZebBqCphfGE`).
- 2026-11-26: PR #33 (T-206) merged by `npm run merge:staging` (first guarded merge), staging `65d655e` verified 33/33 (`dpl_Ak79LHop6rWLkEjc44HnGvpabJ7X`). T-207 (owner-approved): pages work without JavaScript — streamed `<Suspense>` boundaries removed from `/`, `/players`, `/trends`, `/data` and the score strip.
- 2026-11-25: owner added the ruleset targets (T-106 done) and merged #32 (T-305); staging `33dfc88` verified 33/33 (`dpl_FfWMh46fHxLfufSPtK1iE2zZ5f1q`, snapshot `7efabf4a38dd`). T-206: "Cmp" pick column on `/players` (one level only) with a GET form to `/compare`; works without JavaScript; picks survive paging, clear on level/role change, max 4.
- 2026-11-25: owner merged #29 (T-104) and #30 (T-105 guarded merge); staging `140e5ea` verified 33/33. Rulesets for `staging`/`main` created (active, 5 checks, no bypass) but with no target branches yet. T-305 platform note.
- 2026-11-25: T-202 watchlist → PR #31: star toggles on directory rows and profiles (localStorage only, guarded; neutral server render), `/watchlist?ids=` server-rendered from the URL alone (latest level line + Momentum, per level), header tab, CDN-cached route. Verified on its Preview (33/33); owner merged #31 (staging `1ebb4d6`).
- 2026-11-25: T-105 guarded merge command built (check → merge with pinned sha → staging verify → halt on failure); bypass routes added to the deny list. Not enabled: needs owner merge, T-106, one allow rule.
- 2026-11-25: owner merged PR #28 (T-103); staging `ff54c4a` verified 33/33 (`dpl_3awSNJ1y9h8bJEDoj9bpuZSMT5Nb`). T-104: stale deployment/demo/validation statements fixed across README, CLAUDE.md, VERCEL, DEPLOYMENT*, STAGING-*, PRODUCTION-READINESS.
- 2026-11-25: owner merged PRs #24, #25, #26 (staging `5a3c82a`, verified 33/33 on `dpl_3aC7fLEKfwyF3kgo1Q27hVteADww`), then PR #27 (T-102 timings in `verify:preview`). T-103: demo fixtures moved from `src/` to `scripts/fixtures/demo/` with a guard test; client JS unchanged (1,071,243 bytes both builds).
- 2026-11-24: T-101 finished on `claude/project-foundation` (PR #24): DECISIONS, RELEASE_CHECKLIST, ARCHITECTURE "Current system", links from CLAUDE.md/AGENTS.md, AUTONOMOUS-WORKFLOW §6 (gate) and §7 (scheduled runs). Staging gate hardened after an independent security review (forged Preview reports, >100-file PRs, renames, missed ingestion/DB/indexing paths, skipped required checks, more secret forms, fail-closed secret lookup, head re-check, trusted-code requirement). 20 gate tests.
- 2026-11-24: nightly scheduled run created (see below).
- 2026-11-24: PR #24 verified (CI 6/6, verify:preview 33/33 at c460ec3 and cff89ed). T-201 → PR #25, T-203 → PR #26, both built by frontend-engineer agents in isolated worktrees, reviewed and verified on their Previews. Next ready tasks: T-102, T-103, T-104, T-202, T-204.

## Persistent execution (verified capabilities)
- Local scheduled tasks (Claude desktop app): available; run only while the app is open and the Mac is awake
  (keep-awake while working is on; a closed lid sleeps). Missed runs fire at next launch. Runs need a
  permission mode that does not stop on prompts.
- Cloud routines: available but cannot use the local Vercel login/bypass secret, so they cannot run Preview verification.
- PR monitoring: Auto-fix in the desktop app (wakes the session on CI failure/comments).
- **Configured:** scheduled task `prospect-terminal-nightly-dev` ("Prospect Terminal nightly dev run"), daily ~01:30–01:45 local, **Auto mode**, lock `scripts/ops/dev-loop-lock.sh`, state + reports in `~/.claude/prospect-terminal-dev-loop/`. Procedure: AUTONOMOUS-WORKFLOW.md §7. It merges only through `npm run merge:staging` (gate `ready` only; sensitive PRs stay owner-merged).
- **Unattended limits (documented, not worked around):** needs the app open and the Mac awake (lid open); app-level actions (settings, scheduled tasks, connectors) are refused while nobody watches; expired GitHub/Vercel logins need the owner; usage limits end a run early (state kept). The gate requires its code to equal `origin/staging` (true since PR #24 merged).

## Approvals needed from the owner (one consolidated list)
1. Merge PRs the gate marks `needs-human` (sensitive paths); routine `ready` PRs merge via `npm run merge:staging`.
2. T-301 re-scope (measure `playerProfile` instead of `playerLevels`; see TASKS.md).
3. Standing: data licensing (T-601), analytics methodologies (T-401..404), prior-season ingestion (T-501), deploy hook for refresh (T-502).
