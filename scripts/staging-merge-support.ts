/**
 * Decision logic for the guarded staging merge (scripts/staging-merge.ts, docs/AUTONOMOUS-WORKFLOW.md §6).
 * Side-effect free so every refusal path is unit tested (scripts/staging-merge.test.ts).
 *
 * The merge script may merge only when ALL of these hold:
 * - no halt file (a failed post-merge staging verification stops further automatic merges until the owner clears it);
 * - fewer than MAX_MERGES_PER_DAY automatic merges in the last 24 h;
 * - the gate ran from trusted code, exited 0 and returned "ready" for exactly this PR and this sha;
 * - immediately before merging, the PR is still open, not a draft, targets `staging` (never `main`), comes from an
 *   agent branch, and its head is still exactly the verified sha.
 * The merge itself pins the sha (GitHub refuses with 409 if the head moved in the meantime).
 */

/** Files that decide what the gate and the merge script execute; both refuse to run unless these equal origin/staging. */
export const TRUSTED_FILES = [
  "package.json",
  "package-lock.json",
  "scripts/staging-merge.ts",
  "scripts/staging-merge-support.ts",
  "scripts/staging-merge-gate.ts",
  "scripts/staging-gate-support.ts",
  "scripts/verify-preview.ts",
  "scripts/preview-verify-support.ts",
];

export const MERGE_BASE = "staging";
export const AGENT_BRANCH = /^(claude|agent|codex)\//;
export const MAX_MERGES_PER_DAY = 5;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type GateReport = { pr?: number; sha?: string; decision?: string; reasons?: string[] };
export type PrState = { number: number; state: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string };
export type MergeLogEntry = { at: string; pr: number; sha: string; result: string };

export type MergeInput = {
  pr: number;
  sha: string;
  halted: string | null;
  recentMerges: MergeLogEntry[];
  now: Date;
  gateExit: number | null;
  gate: GateReport | null;
  prBeforeMerge: PrState | null;
};

export type MergeDecision = { merge: boolean; reasons: string[] };

/** Merges counted against the daily limit: successful automatic merges in the 24 h before `now`. */
export function mergesInLastDay(log: MergeLogEntry[], now: Date): number {
  return log.filter((e) => e.result === "merged" && now.getTime() - Date.parse(e.at) < DAY_MS && Date.parse(e.at) <= now.getTime()).length;
}

export function decideMerge(m: MergeInput): MergeDecision {
  const r: string[] = [];
  if (!Number.isInteger(m.pr) || m.pr <= 0) r.push("invalid PR number");
  if (!/^[0-9a-f]{40}$/.test(m.sha)) r.push("sha must be the full 40-hex head commit");
  if (m.halted !== null) r.push(`automatic merges are halted: ${m.halted || "halt file present"} (owner clears it)`);
  const n = mergesInLastDay(m.recentMerges, m.now);
  if (n >= MAX_MERGES_PER_DAY) r.push(`daily limit reached: ${n} automatic merges in the last 24 h (max ${MAX_MERGES_PER_DAY})`);

  if (m.gateExit !== 0) r.push(`gate did not pass (exit ${m.gateExit ?? "none"})`);
  if (!m.gate) r.push("no gate report");
  else {
    if (m.gate.decision !== "ready") r.push(`gate decision is "${m.gate.decision ?? "missing"}", not "ready"${m.gate.reasons?.length ? `: ${m.gate.reasons.slice(0, 3).join("; ")}` : ""}`);
    if (m.gate.pr !== m.pr) r.push(`gate report is for PR ${m.gate.pr ?? "?"}, not ${m.pr}`);
    if (m.gate.sha !== m.sha) r.push("gate report is for a different sha");
  }

  const p = m.prBeforeMerge;
  if (!p) r.push("could not re-read the PR before merging");
  else {
    if (p.number !== m.pr) r.push("re-read returned a different PR");
    if (p.state !== "OPEN") r.push(`PR is ${p.state}`);
    if (p.isDraft) r.push("PR is a draft");
    if (p.baseRefName !== MERGE_BASE) r.push(`base is ${p.baseRefName}: only ${MERGE_BASE} is merged automatically`);
    if (!AGENT_BRANCH.test(p.headRefName)) r.push(`head branch ${p.headRefName} is not an agent branch`);
    if (p.headRefOid !== m.sha) r.push("PR head moved after verification");
  }
  return { merge: r.length === 0, reasons: r };
}

/** Parses the append-only merge log (one JSON object per line); malformed lines are ignored, never fatal. */
export function parseMergeLog(text: string): MergeLogEntry[] {
  return text.split("\n").flatMap((l) => {
    try {
      const j = JSON.parse(l);
      return typeof j?.at === "string" && typeof j?.pr === "number" && typeof j?.result === "string" ? [j as MergeLogEntry] : [];
    } catch {
      return [];
    }
  });
}
