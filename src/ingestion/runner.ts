import { snapshotSchema } from "./contracts";
import type {
  SourceAdapter,
  SourceSnapshot,
  NormalizedBatch,
  IngestionIssue,
} from "./contracts";
import { buildPlan, fingerprint, normalizedFingerprint } from "./plan";
import { beginStage, progress } from "./progress";
export interface IngestionReport {
  notices?: NormalizedBatch["notices"];
  provider: string;
  snapshotKey: string;
  contentHash: string;
  rawContentHash: string;
  status:
    | "dry-run"
    | "applied"
    | "quarantined"
    | "applied-with-quarantine"
    | "dry-run-with-quarantine";
  records: number;
  issues: number;
  changed?: number;
  unchanged?: number;
  runId?: string;
  diagnostics?: IngestionIssue[];
  operations?: Record<string, number>;
  databaseComparison?: { insert: number; update: number; unchanged: number };
}
export interface IngestionSink {
  preview?(
    snapshot: SourceSnapshot,
    batch: NormalizedBatch,
  ): Promise<IngestionReport>;
  apply(
    snapshot: SourceSnapshot,
    batch: NormalizedBatch,
  ): Promise<IngestionReport>;
}
export async function ingest(
  adapter: SourceAdapter,
  sink?: IngestionSink,
  options?: { dryRun?: boolean },
): Promise<IngestionReport> {
  beginStage("acquire:start", { provider: adapter.id });
  const startedAt = Date.now();
  const loaded = await adapter.load();
  progress("acquire:done", { ms: Date.now() - startedAt });
  beginStage("validate:snapshot");
  const snapshot = snapshotSchema.parse(loaded);
  if (
    snapshot.provider !== adapter.id ||
    snapshot.adapterVersion !== adapter.version
  )
    throw new Error("Source identity/version mismatch");
  beginStage("normalize:start");
  const normalized = adapter.normalize(snapshot);
  progress("normalize:done", {
    records: normalized.records.length,
    issues: normalized.issues.length,
    notices: normalized.notices?.length ?? 0,
  });
  const notices = normalized.notices?.length
    ? { notices: normalized.notices }
    : {};
  progress("dispatch", {
    path: !sink
      ? "offline-dry-run"
      : options?.dryRun
        ? "database-preview"
        : "database-apply",
  });
  if (sink && options?.dryRun && sink.preview)
    return { ...(await sink.preview(snapshot, normalized)), ...notices };
  if (sink && !options?.dryRun)
    return { ...(await sink.apply(snapshot, normalized)), ...notices };
  const batch = buildPlan(normalized);
  return {
    ...notices,
    provider: snapshot.provider,
    snapshotKey: snapshot.key,
    contentHash: normalizedFingerprint(normalized),
    rawContentHash: fingerprint(snapshot.payload),
    status: batch.issues.length
      ? batch.quarantinePolicy === "records"
        ? "dry-run-with-quarantine"
        : "quarantined"
      : "dry-run",
    operations: batch.records.reduce<Record<string, number>>((counts, r) => {
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      return counts;
    }, {}),
    records: batch.records.length,
    issues: batch.issues.length,
    ...(batch.issues.length ? { diagnostics: batch.issues.slice(0, 100) } : {}),
  };
}
