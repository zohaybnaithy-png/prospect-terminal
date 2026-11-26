/**
 * Organization pages (/orgs, /orgs/[slug], T-204): slugs, lookup, the per-level affiliate model
 * and the table markup, over fictional fixture snapshots. No database, no real players.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LevelSnapshot } from "../src/services/competition/types";
import { levelDirectoryRows } from "../src/services/players/adapter";
import { findOrg, orgHref, orgIndex, orgLevels, orgSlug } from "../src/services/orgs/model";
import { OrgLevels } from "../src/components/orgs/org-tables";
import { AflOrganizationLink } from "../src/components/afl/links";
import { scaleSnapshot } from "./milb-scale-support";

const aa = scaleSnapshot({ ns: 2, level: "aa", teams: 3, days: 12, seed: 2 });
const aaa = scaleSnapshot({ ns: 3, level: "aaa", teams: 3, days: 12, seed: 3 });
// Deliberately out of ladder order: the model sorts levels itself.
const LEVELS: LevelSnapshot[] = [
  { level: "aa", snapshot: aa },
  { level: "aaa", snapshot: aaa },
];
const ORG0 = aa.organizations[0];

const orgRows = (ls: LevelSnapshot, orgId: string) =>
  levelDirectoryRows(ls.snapshot, ls.level).filter((r) => r.organization?.id === orgId);

describe("org slugs", () => {
  test("lower-cased abbreviation, non-alphanumerics collapsed", () => {
    assert.equal(orgSlug({ abbreviation: "NYY" }), "nyy");
    assert.equal(orgSlug({ abbreviation: " Ch.C " }), "ch-c");
    assert.equal(orgHref({ id: ORG0.id, abbreviation: "O0" }), "/orgs/o0");
    assert.equal(orgHref({ id: ORG0.id, abbreviation: "--" }), `/orgs/${ORG0.id}`, "empty slug falls back to the UUID");
  });

  test("organization context links open the organization page, not the filtered directory", () => {
    const html = renderToStaticMarkup(createElement(AflOrganizationLink, { organization: ORG0 }));
    assert.match(html, /href="\/orgs\/o0"/);
    assert.doesNotMatch(html, /\/players\?org=/);
  });
});

describe("orgIndex", () => {
  test("every organization with players, by name; counts are per level from the directory rows", () => {
    const idx = orgIndex(LEVELS);
    assert.deepEqual(
      idx.map((s) => s.org.name),
      ["Fictional Org 0", "Fictional Org 1", "Fictional Org 2"],
    );
    for (const s of idx) {
      for (const ls of LEVELS) assert.equal(s.players[ls.level], orgRows(ls, s.org.id).length, `${s.org.name} ${ls.level}`);
      const distinct = new Set(LEVELS.flatMap((ls) => orgRows(ls, s.org.id).map((r) => r.id)));
      assert.equal(s.total, distinct.size);
      assert.ok(s.total > 0);
    }
  });
});

describe("findOrg", () => {
  test("slug (any case) and internal UUID resolve; anything else is missing", () => {
    assert.deepEqual(findOrg(LEVELS, "o1"), { kind: "ok", org: aa.organizations[1] });
    assert.equal(findOrg(LEVELS, "O1").kind, "ok");
    assert.deepEqual(findOrg(LEVELS, ORG0.id.toUpperCase()), { kind: "ok", org: ORG0 });
    assert.equal(findOrg(LEVELS, "nyy").kind, "missing");
    assert.equal(findOrg(LEVELS, "00000000-0000-4000-8000-000000000000").kind, "missing");
    assert.equal(findOrg(LEVELS, "../etc").kind, "missing");
    assert.equal(findOrg([], "o0").kind, "missing");
  });

  test("two organizations with the same slug are reported, not guessed", () => {
    const clash = scaleSnapshot({ ns: 4, level: "aa", teams: 2, days: 8, seed: 4 });
    // Give org 1 the same abbreviation as org 0 in this level (rows carry the snapshot's orgs).
    clash.organizations = clash.organizations.map((o, i) => (i === 1 ? { ...o, abbreviation: "O0" } : o));
    const r = findOrg([{ level: "aa", snapshot: clash }], "o0");
    assert.equal(r.kind, "ambiguous");
    assert.equal(r.kind === "ambiguous" && r.matches.length, 2);
  });
});

describe("orgLevels", () => {
  const groups = orgLevels(LEVELS, ORG0.id);

  test("levels in ladder order; only this organization's players; every row exactly once per role", () => {
    assert.deepEqual(
      groups.map((g) => g.level),
      ["aaa", "aa"],
    );
    for (const g of groups) {
      const ls = LEVELS.find((l) => l.level === g.level)!;
      const expected = orgRows(ls, ORG0.id);
      const hitters = g.affiliates.flatMap((a) => a.hitters);
      const pitchers = g.affiliates.flatMap((a) => a.pitchers);
      assert.deepEqual(
        hitters.map((r) => r.id).sort(),
        expected.filter((r) => r.batting).map((r) => r.id).sort(),
      );
      assert.deepEqual(
        pitchers.map((r) => r.id).sort(),
        expected.filter((r) => r.pitching).map((r) => r.id).sort(),
      );
      for (const r of [...hitters, ...pitchers]) {
        assert.equal(r.organization?.id, ORG0.id);
        assert.equal(r.level, g.level, "statistics come from the group's own level");
      }
    }
  });

  test("rows are the directory's own rows (identical statistics), sorted by sample size", () => {
    for (const g of groups) {
      const ls = LEVELS.find((l) => l.level === g.level)!;
      const byId = new Map(levelDirectoryRows(ls.snapshot, ls.level).map((r) => [r.id, r]));
      for (const a of g.affiliates) {
        for (const r of [...a.hitters, ...a.pitchers]) assert.equal(r, byId.get(r.id));
        const pa = a.hitters.map((r) => r.batting!.plateAppearances);
        assert.deepEqual(pa, [...pa].sort((x, y) => y - x));
        const bf = a.pitchers.map((r) => r.pitching!.battersFaced);
        assert.deepEqual(bf, [...bf].sort((x, y) => y - x));
        assert.ok(a.team, "fixture players all have a team");
        for (const r of [...a.hitters, ...a.pitchers]) assert.equal(r.team?.id, a.team!.id);
      }
    }
  });

  test("unknown organization: no groups", () => {
    assert.deepEqual(orgLevels(LEVELS, "00000000-0000-4000-8000-000000000000"), []);
  });
});

describe("OrgLevels markup", () => {
  test("level and affiliate headings, team anchors, level-scoped profile and directory links", () => {
    const groups = orgLevels(LEVELS, ORG0.id);
    const html = renderToStaticMarkup(createElement(OrgLevels, { groups, momentumShort: "14D" }));
    assert.match(html, /<h2 id="level-aaa">Triple-A<\/h2>/);
    assert.match(html, /<h2 id="level-aa">Double-A<\/h2>/);
    const team = groups[0].affiliates[0].team!;
    assert.match(html, new RegExp(`id="team-${team.id}"`));
    assert.match(html, new RegExp(`href="/players\\?level=aaa&amp;team=${team.id}"`));
    const first = groups[0].affiliates[0].hitters[0];
    assert.match(html, new RegExp(`href="/players/${first.id}\\?level=aaa"`));
    assert.match(html, /Mom\. 14D/);
  });
});
