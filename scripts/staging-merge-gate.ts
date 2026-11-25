/**
 * Staging merge readiness gate (CHECK ONLY: this script never merges). docs/AUTONOMOUS-WORKFLOW.md §6.
 *
 *   npm run gate:staging -- --pr <n> --sha <full head sha>
 *
 * Trust: the gate and verify-preview must run from code identical to origin/staging (a PR cannot vouch for
 * itself by editing its own scripts or package.json), so it refuses to run when those files differ.
 * It fetches the verified sha, scans that exact diff (paths from the diff headers, both sides of renames),
 * runs verify-preview on that sha, and re-reads the PR head at the end.
 * Verdict JSON on stdout: "ready" (exit 0), "needs-human" (exit 2), "blocked" (exit 1, also on any error).
 * The only merge route is `npm run merge:staging -- --pr <n> --sha <sha>` (scripts/staging-merge.ts), which runs
 * this gate itself and merges only on "ready", with the sha pinned.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { diffPaths, evaluateGate, findSecrets, summarizeChecks, type CheckRollupEntry, type GateInput } from "./staging-gate-support";
import { TRUSTED_FILES } from "./staging-merge-support";

const log = (l: string) => process.stderr.write(`[staging-gate] ${l}\n`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });

/** Files whose content decides what the gate itself executes. */
const TRUSTED = TRUSTED_FILES;

function assertTrustedCode() {
  run("git", ["fetch", "-q", "origin", "staging"]);
  try {
    execFileSync("git", ["diff", "--quiet", "origin/staging", "--", ...TRUSTED], { stdio: "ignore" });
  } catch {
    throw new Error("gate code differs from origin/staging: run the gate from a clean checkout of origin/staging");
  }
}

function bypassSecretValues(): string[] {
  const p = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
  const proj = JSON.parse(run("vercel", ["api", `/v9/projects/${p.projectId}?teamId=${p.orgId}`]));
  return Object.keys(proj.protectionBypass ?? {});
}

const prView = (pr: string) =>
  JSON.parse(run("gh", ["pr", "view", pr, "--json", "number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,changedFiles"])) as GateInput["pr"] & {
    statusCheckRollup: CheckRollupEntry[];
    changedFiles: number;
  };

function main() {
  const pr = arg("pr");
  const sha = arg("sha") ?? "";
  if (!pr || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("usage: --pr <n> --sha <full 40-hex head sha>");
  if (process.argv.includes("--preview-report")) throw new Error("--preview-report is not supported: the gate runs verify-preview itself");
  assertTrustedCode();

  const view = prView(pr);
  log(`PR #${view.number} ${view.headRefName} → ${view.baseRefName} @ ${view.headRefOid.slice(0, 7)}`);

  // The exact commit being judged, not whatever the PR head is when the diff is requested.
  run("git", ["fetch", "-q", "origin", sha]);
  const diff = run("git", ["diff", "--find-renames", `origin/staging...${sha}`]);
  const files = diffPaths(diff);

  const scanErrors: string[] = [];
  let secrets: string[] = [];
  try {
    secrets = bypassSecretValues();
  } catch {
    scanErrors.push("could not read the project's bypass secret for the exact-value scan");
  }
  const secretsFound = findSecrets(diff, secrets);

  let preview: GateInput["preview"] = null;
  try {
    log(`running verify-preview on ${sha.slice(0, 7)}`);
    let out = "";
    try {
      out = execFileSync("node", ["--import", "tsx", "scripts/verify-preview.ts", "--sha", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      // verify-preview exits 1 on a failed check but still prints its JSON report.
      out = (e as { stdout?: string }).stdout ?? "";
    }
    const r = JSON.parse(out) as { ok: boolean; deployment?: { sha?: string; pr?: string }; failed?: string[] };
    preview = { ok: r.ok, sha: r.deployment?.sha, pr: r.deployment?.pr, failed: r.failed };
  } catch {
    preview = null;
  }

  const after = prView(pr);
  const verdict = evaluateGate({
    pr: after,
    expectedSha: sha,
    checks: summarizeChecks(after.statusCheckRollup),
    files,
    changedFileCount: after.changedFiles,
    secretsFound,
    scanErrors,
    preview,
    headAfterChecks: after.headRefOid,
  });
  for (const r of verdict.reasons) log(`${verdict.decision === "blocked" ? "BLOCK" : "HUMAN"} ${r}`);
  log(`decision: ${verdict.decision}`);
  process.stdout.write(JSON.stringify({ pr: after.number, sha, ...verdict }, null, 2) + "\n");
  process.exitCode = verdict.decision === "ready" ? 0 : verdict.decision === "needs-human" ? 2 : 1;
}

try {
  main();
} catch (e) {
  log(`ERROR ${e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "unknown"}`);
  process.stdout.write(JSON.stringify({ decision: "blocked", reasons: ["gate error"] }) + "\n");
  process.exitCode = 1;
}
