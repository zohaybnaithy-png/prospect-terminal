# Autonomous development and verification workflow

How a coding agent (Claude Code) takes a product requirement to a tested, Preview-verified pull request
without a human relaying results between GitHub, Vercel and the browser. The human decides merges,
Production, environment variables, ingestion and anything paid or destructive.

## 1. Loop

1. **Branch.** `git fetch origin && git switch -c claude/<topic> origin/staging`. Development PRs target
   `staging`; `staging` → `main` is a human-approved promotion. Never commit on `main` or `staging`.
2. **Implement** with targeted changes (CLAUDE.md working style).
3. **Test locally:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and the relevant
   e2e suites (`test:cdn:e2e`, `test:views:e2e`, `test:nav:e2e`; Chromium via
   `npx playwright-core install chromium-headless-shell`).
4. **Commit and push** to the `claude/*` branch (`git push -u origin HEAD`). Never force-push a branch
   someone else pushed to; never push to `main`/`staging`.
5. **Open the PR** against `staging`: `gh pr create --base staging --fill` (or a written body).
6. **CI:** `gh pr checks <n> --watch --fail-fast`; on failure `gh run view <run-id> --log-failed`.
   (In the Claude desktop app, the PR monitor/Auto-fix can watch CI instead of polling.)
7. **Preview:** `npm run verify:preview -- --pr <n>` (section 3). It waits up to 15 min for the
   Vercel Preview of the PR's head commit.
8. **Diagnose → fix → repeat** steps 3–7 until CI and Preview verification both pass. Don't weaken tests
   or checks to get green.
9. **Report** in the PR (or to the user): root cause / what changed, files, tests run, CI result, the
   `verify:preview` JSON summary (deployment id, snapshot id, pass/fail counts), open uncertainty.
10. **Stop.** Merging, promoting `staging` → `main`, and anything in section 5 wait for the human.

## 2. Tooling (user-local, no sudo)

| Tool | Location | Check | Recover |
|---|---|---|---|
| GitHub CLI `gh` | `~/.local/bin/gh` (official release zip, SHA-256 verified, Apple-notarized "GitHub") | `gh auth status` | Reinstall: section 4. Re-auth: `gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key` (human approves the device code) |
| Vercel CLI | `~/.local/bin/vercel` (`npm i -g --prefix ~/.local vercel`) | `vercel whoami` (expect the `zo-s` team owner) | `vercel login` (human approves the device code) |
| Repo ↔ Vercel link | `.vercel/project.json` (git-ignored) | file exists | `vercel link --yes --project prospect-terminal --scope zo-s`, then **delete the `.env.local` it writes** (a short-lived `VERCEL_OIDC_TOKEN`) and **revert its `.gitignore` line** (`.vercel/` is already ignored) |
| Git push | macOS keychain (`credential.helper=osxkeychain`) | `git push --dry-run` | Re-enter via a normal `git push` prompt, or `gh auth setup-git` |
| Playwright | `playwright-core` devDependency; browsers in `~/Library/Caches/ms-playwright` | `npx playwright-core --version` | `npx playwright-core install chromium-headless-shell` |

`~/.local/bin` is on `PATH`. A new session should run the checks column first; only a failed auth needs
the human, and only for the browser approval step.

## 3. Preview verification (`npm run verify:preview`)

`scripts/verify-preview.ts` (pure logic and tests: `scripts/preview-verify-support.ts`,
`scripts/preview-verify.test.ts`). Read-only. Usage:

```bash
npm run verify:preview -- --pr 22
npm run verify:preview -- --sha <commit>        # or --deployment dpl_…
npm run verify:preview -- --pr 22 --polls 20 --skip-browser --wait-minutes 30
```

Stdout is one JSON report (`ok`, deployment, snapshot id, passed/failed/warnings, every check); progress
goes to stderr; exit 0 only if every check passes. Checks, in order:

1. Resolve the newest Preview deployment for the commit via the Vercel API. **Refuses Production** and
   any host that is not `*.vercel.app`. An `ERROR` deployment fails with the `vercel inspect … --logs` hint.
2. **Deployment Protection still on:** an anonymous request must get the Vercel SSO redirect / 401.
   Repeated at the end of the run.
3. **Build log** (`vercel inspect --logs`, printed on stderr): build guard not refused, build completed,
   snapshot exported and verified for every level, precomputed views built for every level, each level
   non-empty.
4. **`/health` with bounded cold-start retries:** a fresh serverless instance answers
   `503 {"status":"unavailable","views":{"status":"pending"}}` while it loads the snapshot. That is by
   design. Allowed: up to 12 warm-up attempts (3 s apart), then 10 ready answers with at most 3
   consecutive cold-start answers (a request landing on another new instance). Ready means
   `200 {"status":"ready","views":{"status":"on","fallbacks":0}}`: snapshot mode with precomputed views.
   Anything else fails at once (views `off` means database mode or views disabled).
5. **Pages over HTTP:** `/`, `/players?level=<each level>` (player links present, level label shown,
   levels not serving the same players), and a 404 for an unknown path.
6. **Browser smoke test** (Playwright, headless Chromium): every level's players page, a High-A player
   profile through client-side navigation, zero page errors, zero console errors (except Vercel's
   injected `vercel.live` feedback script, which the site's CSP blocks by design), zero failed
   same-origin requests.
7. **Runtime logs** for the test window (`vercel logs --deployment … --since <start>`): no problems, and
   every instance start (`[competition-views] precomputed views on (snapshot <id>, N levels)`) names the
   build's snapshot id and level count. Startup lines go to stderr, so Vercel tags them `error`; the
   classifier knows which lines are informational and treats everything else at error level as a problem.
   Hobby keeps runtime logs for only ~30–60 min, so the script reads them right after the requests.

### Bypass secret handling

Previews are behind Vercel Authentication (`ssoProtection: all`). The project has one **Protection Bypass
for Automation** secret (created 2026-11-24 with the owner's approval). The script reads it from the
Vercel API in-process and:

- never prints, logs, writes or commits it (errors carry only our own messages);
- sends it only as the `x-vercel-protection-bypass` **request header**, never in a URL or cookie;
- sends it only to the deployment's own `https://<host>.vercel.app` (`mayReceiveBypass`, unit tested):
  `fetch` uses `redirect: "manual"`, and in the browser a per-request route adds the header only for that
  host (never `extraHTTPHeaders`), so vercel.live, vercel.com and any other origin receive nothing.

If the secret is missing (revoked), the script fails and says so. Creating or rotating it is a
human-approved step (`vercel curl` against a Preview offers to create one; revoke in Project Settings →
Deployment Protection). Deployment Protection itself is never disabled.

## 4. Reinstalling `gh` without Homebrew or sudo

```bash
V=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | node -p 'JSON.parse(require("fs").readFileSync(0)).tag_name.slice(1)')
D=$(mktemp -d) && cd "$D" && curl -fsSLO "https://github.com/cli/cli/releases/download/v$V/gh_${V}_macOS_arm64.zip" && curl -fsSLO "https://github.com/cli/cli/releases/download/v$V/gh_${V}_checksums.txt"
grep " gh_${V}_macOS_arm64.zip$" "gh_${V}_checksums.txt" | shasum -a 256 -c - && unzip -q "gh_${V}_macOS_arm64.zip" && install -m 0755 "gh_${V}_macOS_arm64/bin/gh" ~/.local/bin/gh && gh --version
```

(`macOS_amd64` on Intel Macs.) Check the signature with `codesign -dv ~/.local/bin/gh` (TeamIdentifier `VEKTX9H2N7`).

## 5. Always human-approved

- Merging any PR; promoting `staging` → `main`; anything on Production (`vercel --prod`, promote,
  rollback, domains).
- Changing Vercel/GitHub settings or environment variables (`vercel env …`); creating or rotating
  secrets, tokens or deploy keys; disabling Deployment Protection.
- Enabling ingestion, any live `--apply`, migrations against shared databases, destructive cleanup.
- Paid features (Observability Plus, plan upgrades, build machines), new third-party services.
- Force-pushing shared branches, deleting branches others use, rewriting published history.
- Anything touching MLB data licensing or new data sources (CLAUDE.md "Data licensing").

`.claude/settings.json` denies the most dangerous of these commands outright so a mistake cannot run them.

## 6. Staging merge readiness gate (`npm run gate:staging`)

`scripts/staging-merge-gate.ts` (rules in `scripts/staging-gate-support.ts`, tests in `scripts/staging-gate.test.ts`).
**Check only: it never merges.** Usage: `npm run gate:staging -- --pr <n> --sha <full head sha>` (runs
`verify:preview` on that sha unless `--preview-report <file>` is given). Verdicts:

- `ready` (exit 0): base `staging`, agent head branch, PR head equals the verified sha, mergeable and clean,
  every check on the head passed (the five required CI/Vercel checks must be present), Preview verification
  passed on the same sha, no credential-shaped content added, no branch-protection bypass.
- `needs-human` (exit 2): all of the above hold but the PR touches a sensitive path (CI, agent settings or
  rules, deployment/headers config, traffic/health, schema/migrations, ingestion writers, the gates, lockfile, env files).
- `blocked` (exit 1): anything else, including gate errors (fails closed).

Merging remains a human step until the owner approves proposal P-001 (docs/DECISIONS.md).

## 7. Scheduled development runs

- **Mechanism:** a local Claude desktop scheduled task ("Prospect Terminal nightly dev run"). It runs only
  while the Claude app is open and this Mac is awake (lid open; "keep awake while working" holds idle sleep
  off during a run). A run missed while the app was closed starts at the next launch.
- **Single runner:** `scripts/ops/dev-loop-lock.sh acquire|release|status` (atomic mkdir lock in
  `~/.claude/prospect-terminal-dev-loop/`, stale after 8 h). A run that cannot take the lock exits at once.
- **State:** in-flight work in `~/.claude/prospect-terminal-dev-loop/state.json` (task, branch, worktree, PR,
  phase); durable state in the repo (TASKS.md / PROJECT_STATUS.md updated in each PR); a report per run in
  `~/.claude/prospect-terminal-dev-loop/reports/<date>.md`.
- **Isolation:** each run works in its own git worktree under `.claude/worktrees/` cut from `origin/staging`, never in
  the main checkout. It copies `.vercel/project.json` (git-ignored) into the worktree so `verify:preview` works.
- **Order of work per run:** (1) finish the run's own open PRs (CI failures, Preview failures) before new work;
  (2) take the first `ready` task in TASKS.md not already in a PR; at most two tasks per run.
- **Never:** merge, push to `main`/`staging`, touch Production, change settings/env vars/protection, run ingestion
  or live `--apply`, buy anything, weaken tests, or bypass a permission denial. A denied action is recorded as a
  blocker and the run moves on.
- **Unattended limits:** permission prompts that the run's mode does not cover stop the run until someone answers;
  GitHub/Vercel logins that expire need the owner's browser approval; usage limits end a run early (state is kept,
  the next run resumes). These are reported, not worked around.
