/**
 * Offline breakout validation (docs/BREAKOUT-METHOD.md §6, T-405). Reads the build-time snapshot files only:
 * no database connection, no network, nothing written except the report on stdout.
 *
 *   npm run -s snapshot:export                         # once, with the read-only DATABASE_URL
 *   npm run -s analytics:breakout-validate > report.md # reads .data-snapshot/ (PT_SNAPSHOT_DIR to override)
 *   npm run -s analytics:breakout-validate -- --synthetic   # fictional data, exercises the pipeline
 *
 * Options: --level aa (one level), --null-runs N, --churn-step N. Progress goes to stderr.
 * Owner-option comparisons only (the approved defaults are used without them): --statistic raw, --block N
 * (recent and earlier minimums). Choosing among them after seeing real-data results is not allowed (§7).
 */
import path from "node:path";
import { BREAKOUT_SETTINGS, BREAKOUT_VALIDATION, type BreakoutRole, type BreakoutSettings } from "../src/analytics/breakout/config";
import { renderValidationReport, validateRole, type RoleValidation } from "../src/analytics/breakout/validate";
import { MILB_LEVEL_IDS, COMPETITION_LEVEL_LABELS, type MilbLevelId } from "../src/domain/levels";
import { AFL } from "../src/ingestion/sources/mlb-config";
import { snapshotDir } from "../src/services/competition/data-source";
import { snapshotSource } from "../src/services/competition/snapshot-store";
import type { AflSnapshot } from "../src/services/afl/types";
import { syntheticSeason } from "./breakout-synthetic";

const log = (line: string) => process.stderr.write(`[breakout] ${line}\n`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const positiveInt = (name: string, fallback: number) => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};

async function main() {
  const synthetic = process.argv.includes("--synthetic");
  const only = arg("level");
  if (only && !MILB_LEVEL_IDS.includes(only as MilbLevelId)) throw new Error(`--level must be one of ${MILB_LEVEL_IDS.join(", ")}`);
  const nullRuns = positiveInt("null-runs", BREAKOUT_VALIDATION.nullRuns);
  const churnStep = positiveInt("churn-step", 1);
  const statistic = arg("statistic") ?? BREAKOUT_SETTINGS.statistic;
  if (statistic !== "raw" && statistic !== "shrunk-over-raw-se") throw new Error("--statistic must be raw or shrunk-over-raw-se");
  const block = positiveInt("block", BREAKOUT_SETTINGS.nRecent);
  const settings: BreakoutSettings = { ...BREAKOUT_SETTINGS, statistic, nRecent: block, nEarlier: block };
  if (statistic !== BREAKOUT_SETTINGS.statistic || block !== BREAKOUT_SETTINGS.nRecent)
    log(`NOTE: non-default settings (statistic ${statistic}, block ${block}); not the approved configuration`);

  const levels = new Map<MilbLevelId, AflSnapshot>();
  let source: string;
  let snapshotId: string | undefined;
  if (synthetic) {
    source = "SYNTHETIC fictional data (not real players; planted changes)";
    MILB_LEVEL_IDS.forEach((id, i) => levels.set(id, syntheticSeason({ seed: 11 + i }).snapshot));
  } else {
    const dir = snapshotDir();
    const files = snapshotSource(dir, AFL.defaultSeason);
    snapshotId = await files.version();
    source = `build-time snapshot ${path.basename(dir)}/ (season ${AFL.defaultSeason})`;
    for (const id of MILB_LEVEL_IDS) {
      const s = await files.load(id);
      if (s) levels.set(id, s);
      else log(`${id}: no data in the snapshot`);
    }
  }

  // Higher-level appearances per player (MILB_LEVEL_IDS is ordered top level first).
  const datesAt = new Map<MilbLevelId, Map<string, string[]>>();
  for (const [id, s] of levels) {
    const dates = new Map(s.games.filter((g) => g.status === "final" && g.boxscoreComplete).map((g) => [g.id, g.date]));
    const m = new Map<string, string[]>();
    for (const l of [...s.batting, ...s.pitching]) {
      const d = dates.get(l.gameId);
      if (d) (m.get(l.playerId) ?? m.set(l.playerId, []).get(l.playerId)!).push(d);
    }
    datesAt.set(id, m);
  }
  const results: RoleValidation[] = [];
  const names = new Map<string, string>();
  for (const [id, s] of levels) {
    if (only && id !== only) continue;
    for (const p of s.players) names.set(p.id, p.name);
    const higher = new Map<string, string[]>();
    for (const h of MILB_LEVEL_IDS.slice(0, MILB_LEVEL_IDS.indexOf(id)))
      for (const [pid, ds] of datesAt.get(h) ?? []) higher.set(pid, [...(higher.get(pid) ?? []), ...ds]);
    for (const role of ["hitter", "pitcher"] as BreakoutRole[]) {
      const t = Date.now();
      log(`${id} ${role}s…`);
      results.push(validateRole(COMPETITION_LEVEL_LABELS[id], s, role, higher, { nullRuns, churnStep, settings }));
      log(`${id} ${role}s done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
  }
  process.stdout.write(renderValidationReport(results, { source, snapshotId, names, nullRuns, churnStep, settings }));
}

main().catch((error) => {
  log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
