# Project status

Last updated: 2026-11-25. Read this first, then docs/TASKS.md.

## Current state
- `staging` = `5a3c82a` (PRs #22–#26 merged; #24 T-101 foundation, #25 T-201 /compare, #26 T-203 directory depth). `main` = `edc0084`, untouched.
- `staging` Preview `dpl_3aC7fLEKfwyF3kgo1Q27hVteADww` passes `verify:preview` 33/33: snapshot mode, views on,
  5 levels, snapshot `7efabf4a38dd`, Deployment Protection on. (Earlier staging builds used snapshot `3aa112749316`;
  the snapshot id follows the data the build exports.)
- Local: lint, typecheck, build pass; `npm test` all pass except the Momentum golden on macOS only (Math.tanh; CI/Linux passes; T-305).
- Tooling: `gh` and `vercel` in `~/.local/bin`, both logged in (see docs/AUTONOMOUS-WORKFLOW.md §2 to recover).
- `npm run gate:staging` is usable now that its code is on `origin/staging`.
- In review: T-103 demo fixtures out of `src/` (PR #28, gate `ready`).

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
- 2026-11-25: T-202 watchlist on `claude/t-202-watchlist` (local commit, not pushed): star toggles on directory rows and profiles (localStorage only, guarded; neutral server render), `/watchlist?ids=` server-rendered from the URL alone (latest level line + Momentum, per level), header tab, CDN-cached route. Awaiting push, CI and `verify:preview`.
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
- **Configured:** scheduled task `prospect-terminal-nightly-dev` ("Prospect Terminal nightly dev run"), daily ~01:30–01:45 local, **Auto mode**, lock `scripts/ops/dev-loop-lock.sh`, state + reports in `~/.claude/prospect-terminal-dev-loop/`. Procedure: AUTONOMOUS-WORKFLOW.md §7. It never merges.
- **Unattended limits (documented, not worked around):** needs the app open and the Mac awake (lid open); app-level actions (settings, scheduled tasks, connectors) are refused while nobody watches; expired GitHub/Vercel logins need the owner; usage limits end a run early (state kept). The gate requires its code to equal `origin/staging` (true since PR #24 merged).

## Approvals needed from the owner (one consolidated list)
1. **Guarded staging merges (T-105):** allow a single command `npm run merge:staging -- --pr N --sha S` that runs
   `gate:staging` and merges only on `ready`; keep the deny on raw `gh pr merge`. PRs touching sensitive paths stay human-merged.
2. **Branch protection (T-106)** on `main` and `staging`: PR required, CI checks required, no force push.
3. Merge PR #28 (T-103).
4. Standing: data licensing (T-601), analytics methodologies (T-401..404), prior-season ingestion (T-501), deploy hook for refresh (T-502).
