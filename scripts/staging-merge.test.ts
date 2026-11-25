import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideMerge, mergesInLastDay, parseMergeLog, MAX_MERGES_PER_DAY, TRUSTED_FILES, type MergeInput } from "./staging-merge-support";
import { sensitiveChanges } from "./staging-gate-support";

const SHA = "a".repeat(40);
const NOW = new Date("2026-11-25T12:00:00Z");
const ok = (over: Partial<MergeInput> = {}): MergeInput => ({
  pr: 30,
  sha: SHA,
  halted: null,
  recentMerges: [],
  now: NOW,
  gateExit: 0,
  gate: { pr: 30, sha: SHA, decision: "ready", reasons: [] },
  prBeforeMerge: { number: 30, state: "OPEN", isDraft: false, baseRefName: "staging", headRefName: "claude/t-202-watchlist", headRefOid: SHA },
  ...over,
});
const refused = (m: MergeInput, re: RegExp) => {
  const d = decideMerge(m);
  assert.equal(d.merge, false);
  assert.ok(d.reasons.some((r) => re.test(r)), `expected a reason matching ${re}, got ${JSON.stringify(d.reasons)}`);
};

describe("guarded staging merge decision", () => {
  test("merges only when every condition holds", () => {
    assert.deepEqual(decideMerge(ok()), { merge: true, reasons: [] });
  });

  test("gate must be ready, exit 0, and for this exact PR and sha", () => {
    refused(ok({ gate: { pr: 30, sha: SHA, decision: "needs-human", reasons: ["CLAUDE.md: agent operating rules"] }, gateExit: 2 }), /needs-human/);
    refused(ok({ gate: { pr: 30, sha: SHA, decision: "blocked" }, gateExit: 1 }), /"blocked"/);
    refused(ok({ gateExit: 1 }), /gate did not pass \(exit 1\)/);
    refused(ok({ gateExit: null }), /exit none/);
    refused(ok({ gate: null }), /no gate report/);
    refused(ok({ gate: { pr: 31, sha: SHA, decision: "ready" } }), /PR 31, not 30/);
    refused(ok({ gate: { pr: 30, sha: "b".repeat(40), decision: "ready" } }), /different sha/);
  });

  test("never merges into main or any base other than staging", () => {
    for (const base of ["main", "master", "production", "Staging"])
      refused(ok({ prBeforeMerge: { ...ok().prBeforeMerge!, baseRefName: base } }), /only staging is merged automatically/);
  });

  test("PR must still be open, ready for review, from an agent branch, at the verified sha", () => {
    const p = ok().prBeforeMerge!;
    refused(ok({ prBeforeMerge: { ...p, state: "MERGED" } }), /PR is MERGED/);
    refused(ok({ prBeforeMerge: { ...p, state: "CLOSED" } }), /PR is CLOSED/);
    refused(ok({ prBeforeMerge: { ...p, isDraft: true } }), /draft/);
    refused(ok({ prBeforeMerge: { ...p, headRefName: "feature/x" } }), /not an agent branch/);
    refused(ok({ prBeforeMerge: { ...p, headRefName: "staging" } }), /not an agent branch/);
    refused(ok({ prBeforeMerge: { ...p, headRefOid: "c".repeat(40) } }), /head moved/);
    refused(ok({ prBeforeMerge: { ...p, number: 99 } }), /different PR/);
    refused(ok({ prBeforeMerge: null }), /could not re-read/);
  });

  test("halt file stops every automatic merge", () => {
    refused(ok({ halted: "2026-11-25 post-merge staging verification failed" }), /halted: 2026-11-25/);
    refused(ok({ halted: "" }), /halt file present/);
  });

  test("daily limit counts only successful merges in the last 24 h", () => {
    const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
    const merged = Array.from({ length: MAX_MERGES_PER_DAY }, (_, i) => ({ at: at(i + 1), pr: i, sha: SHA, result: "merged" }));
    refused(ok({ recentMerges: merged }), /daily limit reached/);
    const older = merged.map((e, i) => ({ ...e, at: at(25 + i) }));
    assert.equal(decideMerge(ok({ recentMerges: older })).merge, true);
    const refusals = merged.map((e) => ({ ...e, result: "refused" }));
    assert.equal(decideMerge(ok({ recentMerges: refusals })).merge, true);
    assert.equal(mergesInLastDay([{ at: at(-2), pr: 1, sha: SHA, result: "merged" }], NOW), 0, "future timestamps are not counted");
  });

  test("malformed input is refused", () => {
    refused(ok({ sha: "abc123" }), /40-hex/);
    refused(ok({ sha: SHA.toUpperCase() }), /40-hex/);
    refused(ok({ pr: 0 }), /invalid PR/);
    refused(ok({ pr: Number.NaN }), /invalid PR/);
  });

  test("merge log parsing ignores malformed lines", () => {
    const text = [JSON.stringify({ at: NOW.toISOString(), pr: 1, sha: SHA, result: "merged" }), "not json", "{}", JSON.stringify({ at: "x", pr: "2", result: "merged" }), ""].join("\n");
    assert.equal(parseMergeLog(text).length, 1);
  });
});

describe("merge code is protected like the gate", () => {
  test("every trusted file is a sensitive path (a PR changing one always needs the owner)", () => {
    const notSensitive = TRUSTED_FILES.filter((f) => sensitiveChanges([f]).length === 0);
    assert.deepEqual(notSensitive, []);
  });
  test("the gate and the merge script use the same trusted list", () => {
    const gate = readFileSync("scripts/staging-merge-gate.ts", "utf8");
    const merge = readFileSync("scripts/staging-merge.ts", "utf8");
    assert.match(gate, /const TRUSTED = TRUSTED_FILES;/);
    assert.match(merge, /\.\.\.TRUSTED_FILES\]/);
    for (const f of ["scripts/staging-merge.ts", "scripts/staging-merge-support.ts"]) assert.ok(TRUSTED_FILES.includes(f), f);
  });
  test("the merge script merges only through a sha-pinned API call into staging", () => {
    const merge = readFileSync("scripts/staging-merge.ts", "utf8");
    assert.match(merge, /pulls\/\$\{pr\}\/merge`, "-f", `sha=\$\{sha\}`/);
    assert.doesNotMatch(merge, /gh", \["pr", "merge"/);
    assert.doesNotMatch(merge, /\bmain\b.*merge_method|base.*main/);
  });
});

describe("agent permission rules (.claude/settings.json)", () => {
  const perms = JSON.parse(readFileSync(".claude/settings.json", "utf8")).permissions as { allow: string[]; deny: string[] };
  test("every direct merge and protected-branch push route stays denied", () => {
    for (const rule of [
      "Bash(gh pr merge *)", "Bash(gh pr merge)", "Bash(gh api *merge*)", "Bash(gh api *PUT*)", "Bash(gh api * -f *)",
      "Bash(git push --force *)", "Bash(git push --force-with-lease *)", "Bash(git push origin main *)", "Bash(git push origin staging *)",
      "Bash(git push *:main*)", "Bash(git push *:staging*)", "Bash(git push * +*)", "Bash(vercel --prod *)", "Bash(vercel promote *)", "Bash(vercel env *)",
    ])
      assert.ok(perms.deny.includes(rule), `deny list must contain ${rule}`);
  });
  test("no allow rule grants a merge other than the guarded command", () => {
    const mergeAllows = perms.allow.filter((r) => /merge/i.test(r));
    assert.ok(mergeAllows.every((r) => r === "Bash(npm run merge:staging -- --pr * --sha *)"), JSON.stringify(mergeAllows));
  });
});
