import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

// T-103: the fictional demo fixtures live under scripts/fixtures/demo (tests + opt-in seed only).
// Nothing the site ships (src/) may import them, and the old src/ locations must not come back.
const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

test("no src/ module imports the demo fixtures", () => {
  const offenders = sourceFiles(SRC).filter((f) =>
    /from\s+["'][^"']*(fixtures\/demo|data\/demo|services\/prospects|services\/discovery)["']|import\(\s*["'][^"']*fixtures\/demo/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(offenders.map((f) => path.relative(process.cwd(), f)), []);
});

test("demo fixtures are not in src/ any more", () => {
  for (const old of ["src/data/demo.ts", "src/services/prospects.ts", "src/services/discovery.ts"])
    assert.equal(existsSync(path.join(process.cwd(), old)), false, `${old} should live in scripts/fixtures/demo/`);
});
