# Project status

Last updated: 2026-11-24 (session that set up autonomous development). Read this first, then docs/TASKS.md.

## Current state
- `staging` = `db82ec8` (PR #22 build guard + Next 16.4.5, PR #23 autonomous workflow). `main` = `edc0084`, untouched.
- `staging` Preview `dpl_7tAz5eYyXWoDdZaSfpW1SXBLsnXJ` passes `verify:preview` 33/33: snapshot mode,
  views on, 5 levels, snapshot `3aa112749316`, Deployment Protection on. After PR #22 alone: `dpl_25kxCio97zSdPH1KhKKJExwh4ABq` 33/33.
- Local on `db82ec8`: lint, typecheck, build pass; `npm test` 596/597 (Momentum golden fails on macOS only, Math.tanh; CI/Linux passes; T-305).
- Tooling: `gh` and `vercel` in `~/.local/bin`, both logged in (see docs/AUTONOMOUS-WORKFLOW.md §2 to recover).
- In review: PR #24 (T-101: docs, `.claude/agents/`, `npm run gate:staging`, dev-loop lock). Product work in progress: T-201 (see TASKS.md).

## Recent work
- 2026-11-24: T-101 finished on `claude/project-foundation` (PR #24): DECISIONS, RELEASE_CHECKLIST, ARCHITECTURE "Current system", links from CLAUDE.md/AGENTS.md, AUTONOMOUS-WORKFLOW §6 (gate) and §7 (scheduled runs). Staging gate hardened after an independent security review (forged Preview reports, >100-file PRs, renames, missed ingestion/DB/indexing paths, skipped required checks, more secret forms, fail-closed secret lookup, head re-check, trusted-code requirement). 20 gate tests.
- 2026-11-24: nightly scheduled run created (see below).

## Persistent execution (verified capabilities)
- Local scheduled tasks (Claude desktop app): available; run only while the app is open and the Mac is awake
  (keep-awake while working is on; a closed lid sleeps). Missed runs fire at next launch. Runs need a
  permission mode that does not stop on prompts.
- Cloud routines: available but cannot use the local Vercel login/bypass secret, so they cannot run Preview verification.
- PR monitoring: Auto-fix in the desktop app (wakes the session on CI failure/comments).
- **Configured:** scheduled task `prospect-terminal-nightly-dev` ("Prospect Terminal nightly dev run"), daily ~01:30–01:45 local, **Auto mode**, lock `scripts/ops/dev-loop-lock.sh`, state + reports in `~/.claude/prospect-terminal-dev-loop/`. Procedure: AUTONOMOUS-WORKFLOW.md §7. It never merges.
- **Unattended limits (documented, not worked around):** needs the app open and the Mac awake (lid open); app-level actions (settings, scheduled tasks, connectors) are refused while nobody watches; expired GitHub/Vercel logins need the owner; usage limits end a run early (state kept). The gate refuses to run until its code is on `origin/staging` (PR #24 merged), so nightly runs report `gate:staging` as unavailable until then.

## Approvals needed from the owner (one consolidated list)
1. **Guarded staging merges (T-105):** allow a single command `npm run merge:staging -- --pr N --sha S` that runs
   `gate:staging` and merges only on `ready`; keep the deny on raw `gh pr merge`. PRs touching sensitive paths stay human-merged.
2. **Branch protection (T-106)** on `main` and `staging`: PR required, CI checks required, no force push.
3. Merge PR #24 (touches agent rules and gates, so it is yours to merge).
4. Standing: data licensing (T-601), analytics methodologies (T-401..404), prior-season ingestion (T-501), deploy hook for refresh (T-502).
