import { snapshotSchema } from "./contracts";
import type {
  SourceAdapter,
  SourceSnapshot,
  NormalizedBatch,
  IngestionIssue,
} from "./contracts";
import { buildPlan, fingerprint } from "./plan";
export interface IngestionReport {
  provider: string;
  snapshotKey: string;
  contentHash: string;
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
  const snapshot = snapshotSchema.parse(await adapter.load());
  if (
    snapshot.provider !== adapter.id ||
    snapshot.adapterVersion !== adapter.version
  )
    throw new Error("Source identity/version mismatch");
  if (sink && options?.dryRun && sink.preview)
    return sink.preview(snapshot, adapter.normalize(snapshot));
  if (sink && !options?.dryRun)
    return sink.apply(snapshot, adapter.normalize(snapshot));
  const batch = buildPlan(adapter.normalize(snapshot));
  return {
    provider: snapshot.provider,
    snapshotKey: snapshot.key,
    contentHash: fingerprint(snapshot.payload),
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
