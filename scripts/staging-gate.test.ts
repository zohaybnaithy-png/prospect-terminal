import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diffPaths, evaluateGate, findSecrets, sensitiveChanges, summarizeChecks, REQUIRED_CHECKS, type GateInput } from "./staging-gate-support";

const SHA = "f4d6cdc0f4d6cdc0f4d6cdc0f4d6cdc0f4d6cdc0";
const allPass = Object.fromEntries(REQUIRED_CHECKS.map((n) => [n, "pass" as const]));
const base = (): GateInput => ({
  pr: { number: 30, state: "OPEN", isDraft: false, baseRefName: "staging", headRefName: "claude/player-search", headRefOid: SHA, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  expectedSha: SHA,
  checks: { ...allPass, "Vercel Preview Comments": "pass" },
  files: ["src/components/players/search.tsx", "scripts/search.test.ts", "docs/TASKS.md"],
  secretsFound: [],
  preview: { ok: true, sha: SHA, failed: [] },
  changedFileCount: 3,
  headAfterChecks: SHA,
});

describe("staging merge gate", () => {
  test("a clean agent PR with every check and Preview verification passing is ready", () => {
    assert.deepEqual(evaluateGate(base()), { decision: "ready", reasons: [], sensitive: [] });
  });
  test("main or any non-staging base is blocked", () => {
    const g = base();
    g.pr.baseRefName = "main";
    assert.equal(evaluateGate(g).decision, "blocked");
  });
  test("an unverified or moved head is blocked", () => {
    const g = base();
    g.pr.headRefOid = "a".repeat(40);
    assert.equal(evaluateGate(g).decision, "blocked");
    const h = base();
    h.expectedSha = "f4d6cdc";
    assert.equal(evaluateGate(h).decision, "blocked");
  });
  test("pending, failing or missing required checks block", () => {
    for (const s of ["pending", "fail"] as const) {
      const g = base();
      g.checks["Client navigation end to end"] = s;
      assert.equal(evaluateGate(g).decision, "blocked", s);
    }
    const m = base();
    delete m.checks["Vercel"];
    assert.equal(evaluateGate(m).decision, "blocked");
  });
  test("a failing optional check blocks too", () => {
    const g = base();
    g.checks["Some new job"] = "fail";
    assert.equal(evaluateGate(g).decision, "blocked");
  });
  test("conflicts, drafts, closed PRs and non-agent branches block", () => {
    const cases: ((g: GateInput) => void)[] = [
      (g) => (g.pr.mergeable = "CONFLICTING"),
      (g) => (g.pr.mergeStateStatus = "DIRTY"),
      (g) => (g.pr.isDraft = true),
      (g) => (g.pr.state = "MERGED"),
      (g) => (g.pr.headRefName = "release/2027"),
    ];
    for (const c of cases) {
      const g = base();
      c(g);
      assert.equal(evaluateGate(g).decision, "blocked");
    }
  });
  test("Preview verification must pass on the same commit", () => {
    const g = base();
    g.preview = null;
    assert.equal(evaluateGate(g).decision, "blocked");
    const f = base();
    f.preview = { ok: false, sha: SHA, failed: ["health"] };
    assert.equal(evaluateGate(f).decision, "blocked");
    const o = base();
    o.preview = { ok: true, sha: "b".repeat(40) };
    assert.equal(evaluateGate(o).decision, "blocked");
  });
  test("secrets, incomplete scans and a head that moved during the run block", () => {
    const g = base();
    g.secretsFound = ["GitHub token"];
    assert.equal(evaluateGate(g).decision, "blocked");
    const s = base();
    s.scanErrors = ["could not read the project secret"];
    assert.equal(evaluateGate(s).decision, "blocked");
    const m = base();
    m.headAfterChecks = "c".repeat(40);
    assert.equal(evaluateGate(m).decision, "blocked");
  });
  test("a required check that was skipped or neutral blocks; an optional skipped check does not", () => {
    const g = base();
    g.checks["Precomputed view models end to end"] = "skipped";
    assert.equal(evaluateGate(g).decision, "blocked");
    const o = base();
    o.checks["Some optional job"] = "skipped";
    assert.equal(evaluateGate(o).decision, "ready");
  });
  test("a truncated or empty path list blocks", () => {
    const g = base();
    g.changedFileCount = 150;
    assert.equal(evaluateGate(g).decision, "blocked");
    const e = base();
    e.files = [];
    assert.equal(evaluateGate(e).decision, "blocked");
  });
  test("a Preview deployment of another PR blocks", () => {
    const g = base();
    g.preview = { ok: true, sha: SHA, pr: "29" };
    assert.equal(evaluateGate(g).decision, "blocked");
  });
  test("sensitive paths need a human even when everything is green", () => {
    for (const p of [".github/workflows/ci.yml", ".claude/settings.json", "CLAUDE.md", "vercel.json", "src/db/schema.ts", "deploy/deploy.sh", "src/proxy.ts", "package-lock.json", "package.json", "scripts/staging-merge-gate.ts", ".env.local", "src/ingestion/postgres-sink.ts", "src/ingestion/plan.ts", "src/ingestion/refresh/job.ts", "drizzle.config.ts", "src/lib/indexing.ts", "src/lib/cdn-cache.ts", "src/app/robots.ts", "src/app/health/route.ts", ".claude/hooks/pre.sh", "scripts/ops/dev-loop-lock.sh", "scripts/refresh-data.ts"]) {
      const g = base();
      g.files = [...g.files, p];
      const v = evaluateGate(g);
      assert.equal(v.decision, "needs-human", p);
      assert.equal(v.sensitive[0].path, p);
    }
  });
  test("ordinary app, test and docs paths are not sensitive", () => {
    assert.deepEqual(sensitiveChanges(["src/app/players/page.tsx", "src/analytics/momentum.ts", "scripts/frontend.test.ts", "docs/ROADMAP.md", "src/ingestion/sources/milb-stats-api.ts"]), []);
  });
});

test("diff paths include both sides of renames", () => {
  const diff = ["diff --git a/src/db/schema.ts b/src/schema.ts", "similarity index 98%", "rename from src/db/schema.ts", "rename to src/schema.ts", "diff --git a/README.md b/README.md", "@@ -1 +1 @@", "+x"].join("\n");
  const paths = diffPaths(diff).sort();
  assert.deepEqual(paths, ["README.md", "src/db/schema.ts", "src/schema.ts"]);
  assert.equal(sensitiveChanges(paths)[0].path, "src/db/schema.ts");
});

describe("secret scan", () => {
  test("Neon, query-parameter and assignment credential forms", () => {
    for (const line of ["+pw = npg_AbCdEf123456789", "+url=postgresql://user@ep-x.neon.tech/db?password=hunter2", "+u = postgres://u:p/ss@host/db", "+VERCEL_TOKEN=abcdefghijklmnop1234", "+DATABASE_URL: \"pgxyzabcdefghijklmnop\""])
      assert.notDeepEqual(findSecrets("diff --git a/x b/x\n@@ -0,0 +1 @@\n" + line), [], line);
  });
  test("an added line whose content starts with ++ is scanned", () => {
    const t = "ghp_" + "c".repeat(36);
    assert.deepEqual(findSecrets("diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+++" + t), ["GitHub token"]);
  });
  test("flags credential shapes on added lines only", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,3 @@",
      "+const url = 'postgresql://user:hunter2@ep-x.neon.tech/db'",
      "-const old = 'ghp_" + "a".repeat(36) + "'",
      "+// a normal line",
      "+const t = 'ghp_" + "b".repeat(36) + "'",
    ].join("\n");
    assert.deepEqual(findSecrets(diff).sort(), ["GitHub token", "postgres connection string with password"]);
  });
  test("an exact known secret anywhere in an added line is flagged", () => {
    const s = "abcdefghijklmnopqrstuvwxyz012345";
    assert.deepEqual(findSecrets(`@@ -1 +1 @@\n+header: ${s}`, [s]), ["a known project secret"]);
    assert.deepEqual(findSecrets(`@@ -1 +1 @@\n-header: ${s}`, [s]), []);
  });
  test("env var names and docs mentions are fine", () => {
    assert.deepEqual(findSecrets("@@ -1 +1 @@\n+Set INGESTION_DATABASE_URL in your shell; send x-vercel-protection-bypass as a header."), []);
  });
});

test("check rollup normalization: CheckRun and StatusContext, reruns", () => {
  const s = summarizeChecks([
    { name: "A", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "B", status: "IN_PROGRESS", conclusion: null },
    { context: "Vercel", state: "SUCCESS" },
    { name: "C", status: "COMPLETED", conclusion: "FAILURE" },
    { name: "C", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "D", status: "COMPLETED", conclusion: "SKIPPED" },
  ]);
  assert.deepEqual(s, { A: "pass", B: "pending", Vercel: "pass", C: "fail", D: "skipped" });
});
