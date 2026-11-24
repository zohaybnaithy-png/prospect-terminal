/**
 * Vercel build guard (src/lib/vercel-build-guard.ts, wired into next.config.ts): a Vercel
 * production/preview build without PT_DATA_SOURCE=snapshot fails instead of deploying a site that
 * silently runs in database mode. Local, CI and e2e builds are unaffected.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { vercelBuildConfigError } from "../src/lib/vercel-build-guard";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const vercel = (env: Record<string, string | undefined>, target = "preview") => ({ VERCEL: "1", VERCEL_ENV: target, ...env });

describe("vercelBuildConfigError", () => {
  test("a Vercel production or preview build with PT_DATA_SOURCE=snapshot passes (read exactly as the app reads it)", () => {
    for (const target of ["production", "preview"]) {
      assert.equal(vercelBuildConfigError(vercel({ PT_DATA_SOURCE: "snapshot" }, target)), null);
      assert.equal(vercelBuildConfigError(vercel({ PT_DATA_SOURCE: " snapshot\n" }, target)), null, "trimmed, like data-source.ts");
    }
  });

  test("missing, empty or any other value fails, for production and preview", () => {
    for (const target of ["production", "preview"])
      for (const [value, state] of [
        [undefined, "is not set"],
        ["", "is not set"],
        ["   ", "is not set"],
        ["database", 'is set, but not to "snapshot"'],
        ["Snapshot", 'is set, but not to "snapshot"'],
        ['"snapshot"', 'is set, but not to "snapshot"'],
        ["snapshots", 'is set, but not to "snapshot"'],
      ] as const) {
        const msg = vercelBuildConfigError(vercel({ PT_DATA_SOURCE: value }, target));
        assert.ok(msg, `${target} ${JSON.stringify(value)}`);
        assert.match(msg, new RegExp(`Vercel ${target} build refused: PT_DATA_SOURCE ${state.replace(/"/g, '\\"')}\\.`));
        assert.match(msg, new RegExp(`for the ${target === "production" ? "Production" : "Preview"} environment`));
      }
  });

  test("the message never repeats the configured value", () => {
    const value = "postgres://user:s3cr3t-token@db.internal.test/db";
    const msg = vercelBuildConfigError(vercel({ PT_DATA_SOURCE: value }))!;
    assert.ok(!msg.includes(value), "the value itself");
    for (const piece of ["postgres://", "s3cr3t-token", "db.internal.test"]) assert.ok(!msg.includes(piece), piece);
  });

  test("only Vercel production/preview builds are guarded: local, CI, e2e and other Vercel targets pass", () => {
    for (const env of [
      {}, // local npm run build, CI build job
      { PT_DATA_SOURCE: "database" }, // single-server deployment build
      { VERCEL_ENV: "preview" }, // a stray variable without VERCEL=1
      { VERCEL: "1" }, // no target
      { VERCEL: "1", VERCEL_ENV: "development" },
      { VERCEL: "0", VERCEL_ENV: "production" },
    ])
      assert.equal(vercelBuildConfigError(env), null, JSON.stringify(env));
  });
});

describe("next.config wiring", () => {
  const withEnv = async <T>(env: Record<string, string | undefined>, f: () => Promise<T> | T): Promise<T> => {
    const prev = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await f();
    } finally {
      process.env = prev;
    }
  };
  const config = async () => (await import("../next.config")).default;

  test("a Vercel preview/production build without snapshot mode throws; other phases do not", async () => {
    const build = await config();
    for (const target of ["preview", "production"])
      await withEnv({ VERCEL: "1", VERCEL_ENV: target, PT_DATA_SOURCE: undefined }, () => {
        assert.throws(() => build("phase-production-build"), new RegExp(`Vercel ${target} build refused: PT_DATA_SOURCE is not set`));
        assert.doesNotThrow(() => build("phase-production-server"), "never at server start (runtime)");
        assert.doesNotThrow(() => build("phase-development-server"));
      });
    await withEnv({ VERCEL: "1", VERCEL_ENV: "preview", PT_DATA_SOURCE: "Snapshot" }, () =>
      assert.throws(() => build("phase-production-build"), /is set, but not to "snapshot"/),
    );
  });

  test("a correct Vercel snapshot build passes the guard (the existing manifest check still applies)", async (t) => {
    const cwd = process.cwd();
    const dir = mkdtempSync(path.join(cwd, ".pt-test-guard-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const build = await config();
    await withEnv({ VERCEL: "1", VERCEL_ENV: "preview", PT_DATA_SOURCE: "snapshot", PT_SNAPSHOT_DIR: path.relative(cwd, dir) }, () => {
      assert.throws(() => build("phase-production-build"), /manifest\.json is missing/, "snapshot files are still required");
      writeFileSync(path.join(dir, "manifest.json"), "{}");
      assert.doesNotThrow(() => build("phase-production-build"));
    });
  });

  test("local and CI builds without VERCEL are unaffected, in either data mode", async () => {
    const build = await config();
    await withEnv({ VERCEL: undefined, VERCEL_ENV: undefined, PT_DATA_SOURCE: undefined }, () =>
      assert.doesNotThrow(() => build("phase-production-build")),
    );
  });

  test("no build path sets VERCEL: CI does not, and every e2e harness deletes it before next build", () => {
    assert.doesNotMatch(src(".github/workflows/ci.yml"), /\bVERCEL\b\s*:/);
    for (const f of ["scripts/cdn-cache.e2e.ts", "scripts/navigation.e2e.ts", "scripts/precomputed-views.e2e.ts"])
      assert.match(src(f), /delete env\.VERCEL;/, f);
    assert.equal(JSON.parse(src("vercel.json")).buildCommand, "npm run build:vercel");
  });
});
