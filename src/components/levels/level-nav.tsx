import Link from "next/link";
import { LEVELS, type LevelId } from "@/services/players/levels";

/**
 * Level switcher as plain links (shareable URLs, no client state). Levels without an ingested
 * season are shown disabled rather than hidden, so coverage gaps stay visible.
 */
export function LevelNav({
  basePath,
  current,
  available,
  params = {},
  allLabel,
  label = "Level",
  unavailable = [],
}: {
  basePath: string;
  /** "" = all levels (only when `allLabel` is given). */
  current: LevelId | "";
  available: LevelId[];
  params?: Record<string, string>;
  allLabel?: string;
  label?: string;
  /** Levels whose data failed to load in this request (temporary), as opposed to not ingested. */
  unavailable?: LevelId[];
}) {
  const href = (level: LevelId | "") => {
    const q = new URLSearchParams(params);
    if (level) q.set("level", level);
    else q.delete("level");
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav className="level-nav" aria-label={label}>
      <span className="level-nav-label">{label}</span>
      <div className="button-group">
        {allLabel && (
          <Link
            href={href("")}
            className="button-link"
            aria-current={current === "" ? "page" : undefined}
          >
            {allLabel}
          </Link>
        )}
        {LEVELS.map((l) =>
          available.includes(l.id) ? (
            <Link
              key={l.id}
              href={href(l.id)}
              className="button-link"
              title={l.label}
              aria-current={current === l.id ? "page" : undefined}
            >
              {l.short}
            </Link>
          ) : (
            <span
              key={l.id}
              className="button-link disabled"
              title={
                unavailable.includes(l.id)
                  ? `${l.label} — temporarily unavailable`
                  : `${l.label} — no 2026 data ingested`
              }
              aria-disabled="true"
            >
              {l.short}
            </span>
          ),
        )}
      </div>
    </nav>
  );
}
