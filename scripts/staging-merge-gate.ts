/**
 * Staging merge readiness gate (CHECK ONLY: this script never merges). docs/AUTONOMOUS-WORKFLOW.md §6.
 *
 *   npm run gate:staging -- --pr <n> --sha <full head sha> [--preview-report <verify-preview JSON>]
 *
 * Without --preview-report it runs `npm run verify:preview -- --sha <sha>` itself. Prints one JSON verdict
 * on stdout: "ready" (exit 0), "needs-human" (exit 2: only sensitive paths stand in the way) or
 * "blocked" (exit 1). Merging stays a separate, human-authorized step.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { evaluateGate, findSecrets, summarizeChecks, type CheckRollupEntry, type GateInput } from "./staging-gate-support";

const log = (l: string) => process.stderr.write(`[staging-gate] ${l}\n`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

function bypassSecretValues(): string[] {
  try {
    const p = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
    const proj = JSON.parse(run("vercel", ["api", `/v9/projects/${p.projectId}?teamId=${p.orgId}`]));
    return Object.keys(proj.protectionBypass ?? {});
  } catch {
    return [];
  }
}

function main() {
  const pr = arg("pr");
  const sha = arg("sha") ?? "";
  if (!pr) throw new Error("usage: --pr <n> --sha <full head sha> [--preview-report file]");

  const view = JSON.parse(
    run("gh", ["pr", "view", pr, "--json", "number,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,files"]),
  ) as GateInput["pr"] & { statusCheckRollup: CheckRollupEntry[]; files: { path: string }[] };
  log(`PR #${view.number} ${view.headRefName} → ${view.baseRefName} @ ${view.headRefOid.slice(0, 7)}`);

  const diff = run("gh", ["pr", "diff", pr, "--patch"]);
  const secretsFound = findSecrets(diff, bypassSecretValues());

  let preview: GateInput["preview"] = null;
  const reportPath = arg("preview-report");
  try {
    const raw = reportPath
      ? readFileSync(reportPath, "utf8")
      : (log(`running verify:preview on ${sha.slice(0, 7)}`),
        spawnSync("npm", ["run", "-s", "verify:preview", "--", "--sha", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).stdout);
    const r = JSON.parse(raw) as { ok: boolean; deployment?: { sha?: string }; failed?: string[] };
    preview = { ok: r.ok, sha: r.deployment?.sha, failed: r.failed };
  } catch {
    preview = null;
  }

  const verdict = evaluateGate({
    pr: view,
    expectedSha: sha,
    checks: summarizeChecks(view.statusCheckRollup),
    files: view.files.map((f) => f.path),
    secretsFound,
    preview,
    branchProtectionRequiresAdminBypass: view.mergeStateStatus === "BLOCKED",
  });
  for (const r of verdict.reasons) log(`${verdict.decision === "blocked" ? "BLOCK" : "HUMAN"} ${r}`);
  log(`decision: ${verdict.decision}`);
  process.stdout.write(JSON.stringify({ pr: view.number, sha, ...verdict }, null, 2) + "\n");
  process.exitCode = verdict.decision === "ready" ? 0 : verdict.decision === "needs-human" ? 2 : 1;
}

try {
  main();
} catch (e) {
  log(`ERROR ${e instanceof Error ? e.message.split("\n")[0].slice(0, 300) : "unknown"}`);
  process.stdout.write(JSON.stringify({ decision: "blocked", reasons: ["gate error"] }) + "\n");
  process.exitCode = 1;
}
