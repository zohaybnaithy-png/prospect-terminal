# Project status

Last updated: 2026-11-24 (session that set up autonomous development). Read this first, then docs/TASKS.md.

## Current state
- `staging` = `db82ec8` (PR #22 build guard + Next 16.4.5, PR #23 autonomous workflow). `main` = `edc0084`, untouched.
- `staging` Preview `dpl_7tAz5eYyXWoDdZaSfpW1SXBLsnXJ` passes `verify:preview` 33/33: snapshot mode,
  views on, 5 levels, snapshot `3aa112749316`, Deployment Protection on. After PR #22 alone: `dpl_25kxCio97zSdPH1KhKKJExwh4ABq` 33/33.
- Local on `db82ec8`: lint, typecheck, build pass; `npm test` 596/597 (Momentum golden fails on macOS only, Math.tanh; CI/Linux passes; T-305).
- Tooling: `gh` and `vercel` in `~/.local/bin`, both logged in (see docs/AUTONOMOUS-WORKFLOW.md §2 to recover).
- In review: T-101 on branch `claude/project-foundation` (docs, `.claude/agents/`, `npm run gate:staging`).

## Not finished in the setup session (next agent: do these first)
1. T-101 remainder: docs/DECISIONS.md, docs/RELEASE_CHECKLIST.md, refresh docs/ARCHITECTURE.md (current snapshot pipeline; demo-era sections marked historical), link all from CLAUDE.md/AGENTS.md.
2. Scheduled development runs: not created yet (see "Persistent execution").
3. Then the first `ready` task in docs/TASKS.md (T-102).

## Persistent execution (verified capabilities)
- Local scheduled tasks (Claude desktop app): available; run only while the app is open and the Mac is awake
  (keep-awake while working is on; a closed lid sleeps). Missed runs fire at next launch. Runs need a
  permission mode that does not stop on prompts.
- Cloud routines: available but cannot use the local Vercel login/bypass secret, so they cannot run Preview verification.
- PR monitoring: Auto-fix in the desktop app (wakes the session on CI failure/comments).

## Approvals needed from the owner (one consolidated list)
1. **Guarded staging merges (T-105):** allow a single command `npm run merge:staging -- --pr N --sha S` that runs
   `gate:staging` and merges only on `ready`; keep the deny on raw `gh pr merge`. PRs touching sensitive paths stay human-merged.
2. **Branch protection (T-106)** on `main` and `staging`: PR required, CI checks required, no force push.
3. **Scheduled nightly dev run** on this Mac (app open, lid open, auto permission mode).
4. Standing: data licensing (T-601), analytics methodologies (T-401..404), prior-season ingestion (T-501), deploy hook for refresh (T-502).
