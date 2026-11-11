/**
 * Where the site's level data comes from (docs/VERCEL.md):
 *
 * - `database` (default; `PT_DATA_SOURCE` unset or `database`): the long-running server reads each
 *   level from PostgreSQL (`DATABASE_URL`) and checks for new ingestion runs once a minute. This is
 *   the single-server deployment (docs/DEPLOYMENT.md), unchanged.
 * - `snapshot` (`PT_DATA_SOURCE=snapshot`): levels come from the build-time snapshot files
 *   (snapshot-store.ts) bundled with the deployment. The server never connects to the database.
 *   Used on Vercel, where each cold serverless instance would otherwise re-read every level from
 *   Neon. New data needs a new build.
 *
 * Any other value is a configuration error: the site reports data as unavailable rather than
 * guessing a source.
 */
import path from "node:path";
import { DEFAULT_SNAPSHOT_DIR } from "./snapshot-store";

export type DataSource =
  | { kind: "database"; configured: boolean }
  | { kind: "snapshot"; dir: string }
  | { kind: "invalid" };

export const DATA_SOURCE_ENV = "PT_DATA_SOURCE";
export const SNAPSHOT_DIR_ENV = "PT_SNAPSHOT_DIR";

export function dataSource(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): DataSource {
  const raw = env[DATA_SOURCE_ENV]?.trim();
  if (!raw || raw === "database") return { kind: "database", configured: !!env.DATABASE_URL };
  if (raw === "snapshot") return { kind: "snapshot", dir: snapshotDir(env, cwd) };
  return { kind: "invalid" };
}

/** The snapshot directory, relative to the project root unless absolute. */
export function snapshotDir(env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  return path.resolve(cwd, env[SNAPSHOT_DIR_ENV]?.trim() || DEFAULT_SNAPSHOT_DIR);
}

/** Whether there is any data source to load from (false: the demo-only UI, as before). */
export const dataConfigured = (s: DataSource) => s.kind === "snapshot" || (s.kind === "database" && s.configured);
