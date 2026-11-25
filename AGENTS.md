<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Prospect Terminal agent rules (all coding agents)

Kept outside the managed block above, so `next dev` leaves it alone. Claude Code reads it through CLAUDE.md (`@AGENTS.md`), which holds the full project context.

- Start from `docs/PROJECT_STATUS.md` and `docs/TASKS.md` (backlog with acceptance criteria); decisions in `docs/DECISIONS.md`; release gates in `docs/RELEASE_CHECKLIST.md`.
- Work on `claude/<topic>` (or `<agent>/<topic>`) branches cut from `origin/staging`; PRs target `staging`. Committing, pushing such branches, opening PRs, watching CI and running `npm run verify:preview -- --pr <n>` need no further approval (docs/AUTONOMOUS-WORKFLOW.md).
- Before calling a change done: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, the relevant e2e suites, green CI, and a passing `verify:preview` on the PR's Preview.
- Human approval required: merges, pushes to `main`/`staging`, Production, settings/environment variables/Deployment Protection, secrets, ingestion or live `--apply`, paid services, destructive operations.
- Never print or commit credentials; the Vercel bypass secret is sent only as a header to the Preview's own `*.vercel.app` host.
