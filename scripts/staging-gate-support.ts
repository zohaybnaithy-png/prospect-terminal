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
  { pattern: /^vercel\.json$|^next\.config\.ts$/, reason: "deployment / headers / caching configuration" },
  { pattern: /^deploy\//, reason: "server deployment scripts" },
  { pattern: /^src\/lib\/vercel-build-guard\.ts$/, reason: "snapshot-only build guard" },
  { pattern: /^src\/proxy\.ts$|^src\/lib\/traffic\//, reason: "traffic protection / rate limiting" },
  { pattern: /^src\/lib\/health-response\.ts$/, reason: "health endpoint exposure" },
  { pattern: /^src\/db\/|^drizzle\//, reason: "database schema or migrations" },
  { pattern: /^src\/ingestion\/sinks?\/|^scripts\/ingest-/, reason: "ingestion write path" },
  { pattern: /^scripts\/(staging-merge-gate|staging-gate-support|verify-preview|preview-verify-support)\.ts$/, reason: "the verification gates themselves" },
  { pattern: /(^|\/)\.env/, reason: "environment file" },
  // Any dependency change rewrites the lockfile; package.json script-only edits stay routine.
  { pattern: /^package-lock\.json$|^\.npmrc$/, reason: "dependencies (supply chain)" },
];

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
  { name: "postgres connection string with password", re: /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Vercel bypass header with a value", re: /x-vercel-protection-bypass["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}["']/i },
  { name: "OIDC / JWT token", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Scans only added lines of a unified diff. `extraSecrets` are exact values (e.g. the bypass secret). */
export function findSecrets(diff: string, extraSecrets: string[] = []): string[] {
  const hits = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const p of SECRET_PATTERNS) if (p.re.test(line)) hits.add(p.name);
    for (const s of extraSecrets) if (s.length >= 16 && line.includes(s)) hits.add("a known project secret");
  }
  return [...hits];
}

export type CheckRollupEntry = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };

/** Normalizes GitHub's statusCheckRollup (CheckRun + StatusContext) to name → pass/fail/pending. */
export function summarizeChecks(rollup: CheckRollupEntry[]): Record<string, "pass" | "fail" | "pending"> {
  const out: Record<string, "pass" | "fail" | "pending"> = {};
  for (const c of rollup) {
    const name = c.name ?? c.context ?? "?";
    let r: "pass" | "fail" | "pending";
    if (c.state) r = c.state === "SUCCESS" ? "pass" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "fail";
    else if (c.status !== "COMPLETED") r = "pending";
    else r = c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED" ? "pass" : "fail";
    // A rerun can leave several entries for one name: any failure or pending wins over a pass.
    const prev = out[name];
    out[name] = prev === "fail" || r === "fail" ? "fail" : prev === "pending" || r === "pending" ? "pending" : "pass";
  }
  return out;
}

export type GateInput = {
  pr: { number: number; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string; mergeable: string; mergeStateStatus: string };
  expectedSha: string;
  checks: Record<string, "pass" | "fail" | "pending">;
  files: string[];
  secretsFound: string[];
  preview: { ok: boolean; sha?: string; failed?: string[] } | null;
  branchProtectionRequiresAdminBypass: boolean;
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
  for (const [name, s] of Object.entries(g.checks)) if (s !== "pass" && !(REQUIRED_CHECKS as readonly string[]).includes(name)) blockers.push(`check "${name}" is ${s}`);
  if (g.secretsFound.length) blockers.push(`credential-shaped content added: ${g.secretsFound.join(", ")}`);
  if (!g.preview) blockers.push("no Preview verification report");
  else {
    if (!g.preview.ok) blockers.push(`Preview verification failed: ${(g.preview.failed ?? []).slice(0, 3).join("; ")}`);
    if (g.preview.sha !== g.expectedSha) blockers.push("Preview verification was not run on the verified head commit");
  }
  if (g.branchProtectionRequiresAdminBypass) blockers.push("merging would require bypassing branch protection");
  const sensitive = sensitiveChanges(g.files);
  if (blockers.length) return { decision: "blocked", reasons: blockers, sensitive };
  if (sensitive.length) return { decision: "needs-human", reasons: sensitive.map((s) => `${s.path}: ${s.reason}`), sensitive };
  return { decision: "ready", reasons: [], sensitive };
}
