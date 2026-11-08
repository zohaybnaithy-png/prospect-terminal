import Link from "next/link";
import { SourceTag } from "./source-tag";

const FEATURES = [
  {
    name: "Headlines & news",
    detail: "Prospect news needs a licensed news source. Nothing is written or summarized until then.",
  },
  {
    name: "Video highlights",
    detail: "Needs licensed video. Notable box-score lines are under Latest Results.",
  },
  {
    name: "Official transactions & injuries",
    detail: "Not ingested yet. Level Moves shows what box scores show; it is not an official record.",
  },
  {
    name: "Prospect rankings",
    detail: "Needs a licensed ranking source or the Prospect Terminal Grade, which is still in development.",
  },
] as const;

/**
 * Features the homepage will carry once a legitimate source exists. Listed (not hidden) so the
 * front page is honest about what is live; no placeholder content is ever shown in their place.
 */
export function ComingSoonPanel({ showRankings }: { showRankings: boolean }) {
  const features = FEATURES.filter((f) => showRankings || f.name !== "Prospect rankings");
  return (
    <section className="home-panel" aria-labelledby="coming-title">
      <div className="home-section-heading">
        <h2 id="coming-title">
          Not Yet Available <SourceTag kind="pending" />
        </h2>
        <Link href="/data#in-development">In development →</Link>
      </div>
      <ul className="coming-list">
        {features.map((f) => (
          <li key={f.name}>
            <strong>{f.name}</strong>
            <span>{f.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
