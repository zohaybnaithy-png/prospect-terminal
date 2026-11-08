/** Marks whether a homepage feature is built from live ingested data or still needs a source. */
export function SourceTag({ kind }: { kind: "live" | "pending" }) {
  return kind === "live" ? (
    <span className="source-tag live" title="Built from ingested 2026 MLB Stats API box scores">
      Live data
    </span>
  ) : (
    <span className="source-tag pending" title="Not shown until a legitimate data source is connected">
      Needs a source
    </span>
  );
}
