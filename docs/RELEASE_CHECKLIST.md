# Release checklist

Two gates: **staging** (every merged PR; agents) and **production** (promotion `staging` → `main`; owner only).
Older, more detailed checklists: STAGING-CHECKLIST.md, VERCEL.md "Checks on the preview" and "Public launch",
PRODUCTION-READINESS.md "Staged rehearsal". This file is the one to follow.

## A. Before a PR may merge into `staging`

- [ ] Branch cut from current `origin/staging`; PR base is `staging`.
- [ ] Task in docs/TASKS.md updated (status, acceptance criteria met with evidence).
- [ ] `npm run lint`, `npm run typecheck`, `npm test` (Momentum golden: canonical on Linux/CI, D-015), `npm run build`.
- [ ] Relevant e2e: `test:cdn:e2e` (snapshot/caching), `test:views:e2e` (views), `test:nav:e2e` (navigation/UI).
- [ ] GitHub CI green on the exact head commit.
- [ ] `npm run verify:preview -- --pr <n>` exits 0 (protection on, snapshot verified, health ready, pages and browser clean, runtime logs clean).
- [ ] `npm run gate:staging -- --pr <n> --sha <head>`: `ready`, or `needs-human` with the owner told why.
- [ ] Security review for PRs touching config, data paths, headers or dependencies (`security-reviewer` agent).
- [ ] No secrets in the diff; no new data sources; no cross-level blending; no unapproved analytics.

## B. After a merge into `staging`

- [ ] `npm run verify:preview -- --sha <merge commit>` on the staging deployment exits 0.
- [ ] docs/PROJECT_STATUS.md updated (staging commit, deployment id, snapshot id, result).

## C. Promotion `staging` → `main` (owner approval required; not yet done for this architecture)

Blocked until docs/TASKS.md T-601 (data licensing) is resolved, or the owner explicitly accepts a private/non-public production.
- [ ] Owner approval recorded in the PR.
- [ ] Production env reviewed (`deploy/vercel-env.example`): `PT_DATA_SOURCE=snapshot`, read-only snapshot credential, indexing decision (`PT_INDEXING`), analytics.
- [ ] Staging verified at the exact commit being promoted (section B).
- [ ] Vercel plan matches intended use (Hobby is non-commercial).
- [ ] Privacy notice and log retention in place (PRODUCTION-READINESS.md M6) if public.
- [ ] After deploy: `/health` ready, key pages per level, Deployment Protection / public access as intended, rollback target noted (previous production deployment id).
