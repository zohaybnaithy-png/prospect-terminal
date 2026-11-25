/**
 * Guarded staging merge (T-105, docs/AUTONOMOUS-WORKFLOW.md §6).
 *
 *   npm run merge:staging -- --pr <n> --sha <full head sha> [--dry-run]
 *
 * The only route by which an agent merges anything. It merges into `staging` only, never `main`, and only when
 * `gate:staging` returns "ready" for exactly this PR and sha. Sensitive changes are "needs-human", so they are
 * never merged here. Order:
 *   1. refuse unless this script, the gate and verify-preview are identical to origin/staging (a PR cannot
 *      loosen the rules it is judged by);
 *   2. refuse when halted (~/.claude/prospect-terminal-dev-loop/merge-halt) or over the daily limit;
 *   3. run the gate (it runs verify-preview on the sha itself) and require exit 0 + "ready" for this PR/sha;
 *   4. re-read the PR (open, not draft, base staging, agent branch, head == sha);
 *   5. merge with the sha pinned (GitHub returns 409 if the head moved), merge commit, branch kept;
 *   6. verify the resulting staging Preview; on failure write the halt file so no further automatic merge runs
 *      until the owner has looked.
 * Every attempt is appended to ~/.claude/prospect-terminal-dev-loop/merges.log. JSON report on stdout,
 * progress on stderr. Exit 0 = merged and staging verified (or dry run would merge); 1 = refused or failed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideMerge, MERGE_BASE, parseMergeLog, TRUSTED_FILES, type GateReport, type MergeLogEntry, type PrState } from "./staging-merge-support";

// Fixed location (not overridable by environment) so limits and the halt switch cannot be redirected.
const STATE_DIR = path.join(os.homedir(), ".claude", "prospect-terminal-dev-loop");
const HALT_FILE = path.join(STATE_DIR, "merge-halt");
const LOG_FILE = path.join(STATE_DIR, "merges.log");

const log = (l: string) => process.stderr.write(`[merge-staging] ${l}\n`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

function assertTrustedCode() {
  run("git", ["fetch", "-q", "origin", MERGE_BASE]);
  try {
    execFileSync("git", ["diff", "--quiet", `origin/${MERGE_BASE}`, "--", ...TRUSTED_FILES], { stdio: "ignore" });
  } catch {
    throw new Error(`merge/gate code differs from origin/${MERGE_BASE}: run from a clean checkout of origin/${MERGE_BASE}`);
  }
}

function readPr(pr: number): PrState | null {
  try {
    return JSON.parse(run("gh", ["pr", "view", String(pr), "--json", "number,state,isDraft,baseRefName,headRefName,headRefOid"])) as PrState;
  } catch {
    return null;
  }
}

function record(entry: MergeLogEntry & Record<string, unknown>) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

function finish(report: Record<string, unknown>, ok: boolean) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = ok ? 0 : 1;
}

function main() {
  const pr = Number(arg("pr"));
  const sha = arg("sha") ?? "";
  const dryRun = process.argv.includes("--dry-run");
  const allowed = new Set(["--pr", "--sha", "--dry-run", String(arg("pr")), sha]);
  const extra = process.argv.slice(2).filter((a) => !allowed.has(a));
  if (extra.length) throw new Error(`unsupported arguments: ${extra.join(" ")}`);

  assertTrustedCode();

  const halted = existsSync(HALT_FILE) ? readFileSync(HALT_FILE, "utf8").trim() : null;
  const recentMerges = existsSync(LOG_FILE) ? parseMergeLog(readFileSync(LOG_FILE, "utf8")) : [];

  // Cheap refusals first (halt, limit, malformed input) so a halted loop does not spend a Preview run.
  const pre = decideMerge({ pr, sha, halted, recentMerges, now: new Date(), gateExit: 0, gate: { pr, sha, decision: "ready" }, prBeforeMerge: { number: pr, state: "OPEN", isDraft: false, baseRefName: MERGE_BASE, headRefName: "claude/x", headRefOid: sha } });
  if (!pre.merge) {
    for (const r of pre.reasons) log(`REFUSE ${r}`);
    record({ at: new Date().toISOString(), pr, sha, result: "refused", reasons: pre.reasons });
    return finish({ pr, sha, merged: false, reasons: pre.reasons }, false);
  }

  log(`running gate:staging for PR #${pr} @ ${sha.slice(0, 7)}`);
  const g = spawnSync("node", ["--import", "tsx", "scripts/staging-merge-gate.ts", "--pr", String(pr), "--sha", sha], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  let gate: GateReport | null = null;
  try {
    gate = JSON.parse(g.stdout) as GateReport;
  } catch {
    gate = null;
  }

  const prBeforeMerge = readPr(pr);
  const decision = decideMerge({ pr, sha, halted, recentMerges, now: new Date(), gateExit: g.status, gate, prBeforeMerge });
  if (!decision.merge) {
    for (const r of decision.reasons) log(`REFUSE ${r}`);
    record({ at: new Date().toISOString(), pr, sha, result: "refused", reasons: decision.reasons });
    return finish({ pr, sha, merged: false, gate: gate?.decision ?? null, reasons: decision.reasons }, false);
  }
  if (dryRun) {
    log("dry run: every condition holds; not merging");
    return finish({ pr, sha, merged: false, dryRun: true, wouldMerge: true, gate: gate?.decision }, true);
  }

  // Merge with the verified sha pinned. Merge commit (history kept), head branch not deleted.
  const slug = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  let mergeSha = "";
  try {
    const out = JSON.parse(
      run("gh", ["api", "-X", "PUT", `repos/${slug}/pulls/${pr}/merge`, "-f", `sha=${sha}`, "-f", "merge_method=merge", "-f", `commit_title=Merge pull request #${pr} (guarded: gate ready @ ${sha.slice(0, 7)})`]),
    ) as { merged?: boolean; sha?: string };
    if (!out.merged || !out.sha) throw new Error("GitHub did not report a merge");
    mergeSha = out.sha;
  } catch (e) {
    const why = `merge call failed: ${e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "unknown"}`;
    log(`FAIL ${why}`);
    record({ at: new Date().toISOString(), pr, sha, result: "merge-failed", reasons: [why] });
    return finish({ pr, sha, merged: false, reasons: [why] }, false);
  }
  log(`merged PR #${pr} into ${MERGE_BASE} as ${mergeSha.slice(0, 7)}`);
  record({ at: new Date().toISOString(), pr, sha, result: "merged", mergeSha });

  // Post-merge: the resulting staging Preview must pass, otherwise stop all further automatic merges.
  log(`verifying the ${MERGE_BASE} Preview for ${mergeSha.slice(0, 7)}`);
  const v = spawnSync("node", ["--import", "tsx", "scripts/verify-preview.ts", "--sha", mergeSha, "--wait-minutes", "20"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  let verified: { ok?: boolean; passed?: number; failed?: string[]; deployment?: { id?: string } } = {};
  try {
    verified = JSON.parse(v.stdout);
  } catch {
    verified = { ok: false, failed: ["verify-preview produced no report"] };
  }
  const ok = v.status === 0 && verified.ok === true;
  if (!ok) {
    const why = `post-merge ${MERGE_BASE} verification failed for PR #${pr} (${mergeSha.slice(0, 7)}): ${(verified.failed ?? []).slice(0, 3).join("; ")}`;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(HALT_FILE, `${new Date().toISOString()} ${why}\n`);
    log(`HALT ${why}`);
    record({ at: new Date().toISOString(), pr, sha, result: "staging-verify-failed", mergeSha, reasons: [why] });
  } else {
    record({ at: new Date().toISOString(), pr, sha, result: "staging-verified", mergeSha, deployment: verified.deployment?.id });
  }
  return finish({ pr, sha, merged: true, mergeSha, stagingVerified: ok, deployment: verified.deployment?.id ?? null, passed: verified.passed ?? null, failed: verified.failed ?? [] }, ok);
}

try {
  main();
} catch (e) {
  const why = e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "unknown";
  log(`ERROR ${why}`);
  finish({ merged: false, reasons: [why] }, false);
}
