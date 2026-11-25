/**
 * Pure rules for `scripts/staging-merge-gate.ts`: may this PR be merged into `staging` without a human
 * reviewing it first? Side-effect free so it is unit tested (scripts/staging-gate.test.ts).
 * See docs/AUTONOMOUS-WORKFLOW.md §6.
 */

/** CI checks every staging PR must have passed on its exact head commit. */
export const REQUIRED_CHECKS = [
  "Lint, typecheck, tests, production build",
  "Snapshot build and CDN caching end to end",
  "Client navigation end to end",
  "Precomputed view models end to end",
  "Vercel",
] as const;

/**
 * Paths whose change always needs a human: CI and agent permissions, deployment and security
 * configuration, database schema/migrations, ingestion write paths, and the agent rules themselves.
 * A PR touching any of them is "needs-human" even when every check is green.
 */
export const SENSITIVE_PATHS: { pattern: RegExp; reason: string }[] = [
  { pattern: /^\.github\//, reason: "CI / GitHub configuration" },
  { pattern: /^\.claude\/(settings|agents)/, reason: "agent permissions or agent definitions" },
  { pattern: /^(CLAUDE|AGENTS)\.md$/, reason: "agent operating rules" },
  { pattern: /^docs\/AUTONOMOUS-WORKFLOW\.md$/, reason: "autonomy and approval rules" },
  { pattern: /^\.claude\/hooks\//, reason: "agent hooks" },
  { pattern: /^vercel\.json$|^next\.config\.ts$/, reason: "deployment / headers / caching configuration" },
  { pattern: /^deploy\//, reason: "server deployment scripts" },
  { pattern: /^src\/lib\/vercel-build-guard\.ts$/, reason: "snapshot-only build guard" },
  { pattern: /^src\/proxy\.ts$|^src\/lib\/traffic\//, reason: "traffic protection / rate limiting" },
  { pattern: /^src\/lib\/health-response\.ts$|^src\/app\/health\//, reason: "health endpoint exposure" },
  { pattern: /^src\/lib\/(indexing|crawl-policy|cdn-cache)\.ts$|^src\/app\/(robots|sitemap)\.ts$/, reason: "indexing / crawl / CDN caching policy" },
  { pattern: /^src\/db\/|^drizzle\/|^drizzle\.config\.ts$/, reason: "database schema, migrations or DB config" },
  { pattern: /^src\/ingestion\/(postgres-sink|plan|db-target|runner|milb-runner|milb-backfill)\.ts$|^src\/ingestion\/refresh\/|^scripts\/(ingest-|refresh-data|ops\/milb-backfill)/, reason: "ingestion / refresh write path" },
  { pattern: /^scripts\/(staging-merge|staging-merge-support|staging-merge-gate|staging-gate-support|verify-preview|preview-verify-support)\.ts$|^scripts\/ops\/dev-loop-lock\.sh$/, reason: "the verification gates themselves" },
  { pattern: /(^|\/)\.env/, reason: "environment file" },
  // package.json scripts decide what CI and the gates run ("test", "verify:preview", install hooks).
  { pattern: /^package(-lock)?\.json$|^\.npmrc$/, reason: "dependencies or npm scripts (supply chain / what CI runs)" },
];

/** Every path a unified diff touches, including both sides of a rename or copy. */
export function diffPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      out.add(m[1]);
      out.add(m[2]);
      continue;
    }
    const r = line.match(/^(rename|copy) (from|to) (.+)$/);
    if (r) out.add(r[3]);
  }
  return [...out];
}

export function sensitiveChanges(paths: string[]): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  for (const p of paths) {
    const hit = SENSITIVE_PATHS.find((s) => s.pattern.test(p));
    if (hit) out.push({ path: p, reason: hit.reason });
  }
  return out;
}

/** Credential-shaped strings that must never appear in an added line. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "postgres connection string with password", re: /postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@/i },
  { name: "postgres connection string with password parameter", re: /postgres(ql)?:\/\/\S*[?&]password=/i },
  { name: "Neon password", re: /\bnpg_[A-Za-z0-9]{12,}\b/ },
  { name: "credential assignment", re: /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|DATABASE_URL)\s*[:=]\s*["']?[^\s"'$<{]{16,}/ },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Vercel bypass header with a value", re: /x-vercel-protection-bypass["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/i },
  { name: "OIDC / JWT token", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Scans only added lines of a unified diff. `extraSecrets` are exact values (e.g. the bypass secret). */
export function findSecrets(diff: string, extraSecrets: string[] = []): string[] {
  const hits = new Set<string>();
  // Header lines ("+++ b/path") appear only between "diff --git" and the first "@@" of each file; inside
  // hunks, a line starting with "+++" is added content and is scanned like any other.
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    if (!inHunk || !line.startsWith("+")) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.add(p.name);
    for (const s of extraSecrets) if (s.length >= 16 && line.includes(s)) hits.add("a known project secret");
  }
  return [...hits];
}

export type CheckRollupEntry = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };

export type CheckResult = "pass" | "skipped" | "fail" | "pending";

/**
 * Normalizes GitHub's statusCheckRollup (CheckRun + StatusContext) to name → result. "pass" is SUCCESS only;
 * SKIPPED/NEUTRAL are "skipped" (acceptable for optional checks, never for required ones).
 */
export function summarizeChecks(rollup: CheckRollupEntry[]): Record<string, CheckResult> {
  const rank: Record<CheckResult, number> = { fail: 3, pending: 2, skipped: 1, pass: 0 };
  const out: Record<string, CheckResult> = {};
  for (const c of rollup) {
    const name = c.name ?? c.context ?? "?";
    let r: CheckResult;
    if (c.state) r = c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail";
    else if (c.status !== "COMPLETED") r = "pending";
    else r = c.conclusion === "SUCCESS" ? "pass" : c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED" ? "skipped" : "fail";
    // A rerun can leave several entries for one name: the worst result wins.
    const prev = out[name];
    out[name] = prev && rank[prev] > rank[r] ? prev : r;
  }
  return out;
}

export type GateInput = {
  pr: { number: number; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string; mergeable: string; mergeStateStatus: string; changedFiles?: number };
  expectedSha: string;
  checks: Record<string, CheckResult>;
  /** Paths from the diff of the verified sha (both sides of renames). */
  files: string[];
  /** Files GitHub reports as changed, to detect a truncated or mismatched path list. */
  changedFileCount?: number;
  secretsFound: string[];
  /** Set when a scan input could not be obtained (e.g. the project secret lookup failed): fails closed. */
  scanErrors?: string[];
  preview: { ok: boolean; sha?: string; pr?: string | number; failed?: string[] } | null;
  /** PR head re-read after all checks; must still equal expectedSha. */
  headAfterChecks?: string;
};

export type GateVerdict = { decision: "ready" | "needs-human" | "blocked"; reasons: string[]; sensitive: { path: string; reason: string }[] };

/**
 * ready: every condition holds; needs-human: only sensitive paths stand in the way; blocked: anything else.
 * The head branch must be a claude/* (or other agent) branch: release branches never auto-merge.
 */
export function evaluateGate(g: GateInput): GateVerdict {
  const blockers: string[] = [];
  if (g.pr.state !== "OPEN") blockers.push(`PR is ${g.pr.state}`);
  if (g.pr.isDraft) blockers.push("PR is a draft");
  if (g.pr.baseRefName !== "staging") blockers.push(`base is ${g.pr.baseRefName}, not staging`);
  if (!/^(claude|agent|codex)\//.test(g.pr.headRefName)) blockers.push(`head branch ${g.pr.headRefName} is not an agent branch`);
  if (!/^[0-9a-f]{40}$/.test(g.expectedSha)) blockers.push("expected head sha must be a full 40-hex commit id");
  if (g.pr.headRefOid !== g.expectedSha) blockers.push(`PR head ${g.pr.headRefOid.slice(0, 7)} is not the verified commit ${g.expectedSha.slice(0, 7)}`);
  if (g.pr.mergeable !== "MERGEABLE") blockers.push(`mergeable is ${g.pr.mergeable}`);
  if (g.pr.mergeStateStatus !== "CLEAN") blockers.push(`merge state is ${g.pr.mergeStateStatus}`);
  for (const name of REQUIRED_CHECKS) {
    const s = g.checks[name];
    if (s !== "pass") blockers.push(`required check "${name}" is ${s ?? "missing"}`);
  }
  for (const [name, s] of Object.entries(g.checks))
    if ((s === "fail" || s === "pending") && !(REQUIRED_CHECKS as readonly string[]).includes(name)) blockers.push(`check "${name}" is ${s}`);
  if (g.files.length === 0) blockers.push("no changed paths found in the diff");
  if (g.changedFileCount !== undefined && g.changedFileCount > 0) {
    // Renames contribute two paths, so the diff may list more paths than GitHub's count, never fewer.
    if (g.files.length < g.changedFileCount) blockers.push(`diff lists ${g.files.length} paths but GitHub reports ${g.changedFileCount} changed files`);
  }
  if (g.secretsFound.length) blockers.push(`credential-shaped content added: ${g.secretsFound.join(", ")}`);
  for (const e of g.scanErrors ?? []) blockers.push(`scan incomplete: ${e}`);
  if (!g.preview) blockers.push("no Preview verification report");
  else {
    if (!g.preview.ok) blockers.push(`Preview verification failed: ${(g.preview.failed ?? []).slice(0, 3).join("; ")}`);
    if (g.preview.sha !== g.expectedSha) blockers.push("Preview verification was not run on the verified head commit");
    if (g.preview.pr !== undefined && String(g.preview.pr) !== String(g.pr.number)) blockers.push(`Preview deployment belongs to PR ${g.preview.pr}, not #${g.pr.number}`);
  }
  if (g.headAfterChecks !== undefined && g.headAfterChecks !== g.expectedSha) blockers.push("PR head moved while the gate ran");
  const sensitive = sensitiveChanges(g.files);
  if (blockers.length) return { decision: "blocked", reasons: blockers, sensitive };
  if (sensitive.length) return { decision: "needs-human", reasons: sensitive.map((s) => `${s.path}: ${s.reason}`), sensitive };
  return { decision: "ready", reasons: [], sensitive };
}
