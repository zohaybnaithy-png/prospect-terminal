/**
 * Golden regression test of every Momentum-derived output (scripts/momentum-golden-support.ts).
 *
 * The expected file, scripts/fixtures/momentum-golden.json, was generated from the UNMODIFIED
 * engine. Performance changes must reproduce it exactly: never regenerate it to make a change pass.
 * A deliberate, discussed change to Momentum outputs is the only reason to regenerate:
 *
 *   MOMENTUM_GOLDEN_UPDATE=1 node --import tsx --test scripts/momentum-golden.test.ts
 *
 * On a mismatch the test lists the first differing entries and prints their current values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { EXAMPLE_KEYS, canonical, digest, goldenEntries, goldenFixtures } from "./momentum-golden-support";

const FILE = new URL("./fixtures/momentum-golden.json", import.meta.url);

interface GoldenFile {
  description: string;
  generatedFrom: string;
  entryCount: number;
  entries: Record<string, string>;
  examples: Record<string, string>;
}

function compute() {
  const entries = goldenEntries();
  const hashes = Object.fromEntries([...entries].map(([k, v]) => [k, digest(v)]));
  const examples = Object.fromEntries(EXAMPLE_KEYS(entries).map((k) => [k, canonical(entries.get(k))]));
  return { entries, hashes, examples };
}

if (process.env.MOMENTUM_GOLDEN_UPDATE === "1") {
  test("regenerate the Momentum golden file (explicit, reviewed changes only)", () => {
    const { hashes, examples } = compute();
    let commit = "unknown";
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      /* not a git checkout */
    }
    const file: GoldenFile = {
      description:
        "Golden Momentum outputs (fictional fixtures). Generated from the unmodified engine; performance changes must reproduce it exactly. Do not regenerate to make a change pass.",
      generatedFrom: commit,
      entryCount: Object.keys(hashes).length,
      entries: hashes,
      examples,
    };
    writeFileSync(FILE, `${JSON.stringify(file, null, 1)}\n`);
  });
} else {
  test("every Momentum output matches the golden file exactly", () => {
    const golden = JSON.parse(readFileSync(FILE, "utf8")) as GoldenFile;
    const { entries, hashes, examples } = compute();
    const expectedKeys = Object.keys(golden.entries);
    const actualKeys = Object.keys(hashes);
    assert.equal(actualKeys.length, golden.entryCount, "entry count");
    assert.deepEqual(actualKeys, expectedKeys, "same entries, same order");
    const changed = actualKeys.filter((k) => hashes[k] !== golden.entries[k]);
    if (changed.length) {
      const detail = changed
        .slice(0, 10)
        .map((k) => `  ${k}\n    now: ${canonical(entries.get(k)).slice(0, 600)}`)
        .join("\n");
      assert.fail(`${changed.length} of ${actualKeys.length} Momentum outputs changed:\n${detail}`);
    }
    for (const [k, v] of Object.entries(golden.examples)) assert.equal(examples[k], v, `example ${k}`);
  });

  test("the golden covers every fixture, section, role, window and model", () => {
    const golden = JSON.parse(readFileSync(FILE, "utf8")) as GoldenFile;
    const keys = Object.keys(golden.entries);
    for (const f of ["milb", "afl", "edge", "empty"]) assert.ok(keys.some((k) => k.startsWith(`${f}/`)), f);
    for (const section of ["momentum", "timeline", "fingerprint", "profile", "comparable", "qualified", "distribution", "trends-risers", "trends-map", "scales", "compare-models", "riser-sets", "map-sets", "trending", "directory", "variant-change-sd", "variant-no-persistence-floor"])
      assert.ok(keys.some((k) => k.split("/")[1] === section), section);
    for (const w of ["7d", "14d", "30d"])
      for (const role of ["hitter", "pitcher"]) assert.ok(keys.some((k) => k.includes("/momentum/") && k.endsWith(`/${role}/${w}`)), `${role} ${w}`);
    // Every model is recorded inside each momentum entry.
    const { entries } = compute();
    const one = entries.get(keys.find((k) => k.startsWith("edge/momentum/"))!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(one).sort(), ["balanced", "production-heavy", "skills-heavy"]);
  });

  test("edge cases are present: every status, confidence level and persistence state the fixtures can reach", () => {
    const { entries } = compute();
    const statuses = new Set<string>(), confidence = new Set<string>(), persistence = new Set<string>(), bands = new Set<string>();
    for (const [k, v] of entries)
      if (k.includes("/momentum/"))
        for (const m of Object.values(v as Record<string, { status: string; confidence: string; persistence: { state: string }; band: { id: string } | null }>)) {
          statuses.add(m.status);
          confidence.add(m.confidence);
          persistence.add(m.persistence.state);
          if (m.band) bands.add(m.band.id);
        }
    for (const s of ["ok", "no-recent", "insufficient-recent", "no-baseline"]) assert.ok(statuses.has(s), `status ${s}: ${[...statuses]}`);
    for (const c of ["low", "medium", "high"]) assert.ok(confidence.has(c), `confidence ${c}: ${[...confidence]}`);
    for (const p of ["insufficient", "neutral", "emerging"]) assert.ok(persistence.has(p), `persistence ${p}: ${[...persistence]}`);
    assert.ok(persistence.size >= 5, `persistence states covered: ${[...persistence]}`);
    assert.ok(bands.size >= 4, `bands covered: ${[...bands]}`);
    const asOf = entries.get("empty/asOf") as { asOf: string | null };
    assert.equal(asOf.asOf, null, "empty fixture: no completed games");
  });

  test("outputs are deterministic across fresh fixture objects (no order or cache dependence)", () => {
    const a = goldenEntries(goldenFixtures().filter((f) => f.name !== "milb"));
    const b = goldenEntries(goldenFixtures().filter((f) => f.name !== "milb"));
    assert.deepEqual([...a.keys()], [...b.keys()]);
    for (const [k, v] of a) assert.equal(digest(v), digest(b.get(k)), k);
  });
}
