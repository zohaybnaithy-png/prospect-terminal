import Link from "@/components/ui/app-link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { MOMENTUM_WINDOWS } from "@/analytics/config";
import { getCompetitionData } from "@/services/competition";
import { levelAsOf } from "@/services/competition/model";
import { momentumWindowFor } from "@/services/players/directory";
import { levelById } from "@/services/players/levels";
import { findOrg, orgHref, orgLevels } from "@/services/orgs/model";
import { AflDataNotice } from "@/components/afl/data-notice";
import { OrgLevels } from "@/components/orgs/org-tables";
import { shortDate } from "@/lib/format";

/**
 * One MLB organization: its players at every loaded level, by affiliate. Addressed by the
 * organization's abbreviation slug (`/orgs/nyy`) or internal UUID. Unknown slugs are not found.
 */
const resolve = cache(async (slug: string) => {
  const data = await getCompetitionData();
  if (data.status !== "ok") return { kind: "unavailable" as const, status: data.status };
  const lookup = findOrg(data.levels, slug);
  if (lookup.kind !== "ok") return lookup;
  return { kind: "ok" as const, org: lookup.org, levels: data.levels, groups: orgLevels(data.levels, lookup.org.id) };
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const r = await resolve((await params).slug);
  if (r.kind === "ok")
    return {
      title: r.org.name,
      alternates: { canonical: orgHref(r.org) },
      description: `${r.org.name} prospects at every level: affiliates, rosters, season lines and Momentum.`,
    };
  return { title: r.kind === "missing" ? "Organization not found" : "Organization" };
}

export default async function OrgPage({ params }: { params: Promise<{ slug: string }> }) {
  const r = await resolve((await params).slug);
  const back = (
    <Link href="/orgs" className="back-link">
      ← Organizations
    </Link>
  );
  if (r.kind === "unavailable")
    return (
      <>
        {back}
        <AflDataNotice status={r.status} />
      </>
    );
  if (r.kind === "ambiguous")
    return (
      <>
        {back}
        <div className="page-heading">
          <h1>More than one organization matches</h1>
          <ul>
            {r.matches.map((o) => (
              <li key={o.id}>
                <Link href={`/orgs/${o.id}`}>{o.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      </>
    );
  if (r.kind !== "ok") notFound();
  const mWindow = MOMENTUM_WINDOWS[momentumWindowFor("season")];
  const shown = r.levels.filter((ls) => r.groups.some((g) => g.level === ls.level));
  const through = shown.map((ls) => {
    const asOf = levelAsOf(ls);
    return `${levelById(ls.level).short} ${asOf ? shortDate(asOf) : "no completed games"}`;
  });
  const players = new Set(r.groups.flatMap((g) => g.affiliates.flatMap((a) => [...a.hitters, ...a.pitchers].map((p) => p.id)))).size;
  return (
    <>
      {back}
      <div className="page-heading">
        <p className="eyebrow">Organization · {r.org.abbreviation}</p>
        <h1>{r.org.name}</h1>
        <p>
          Players whose latest source roster observation at a level is with this organization, by
          level and affiliate. Season lines and Momentum are from that level only; nothing is
          combined or adjusted across levels.
        </p>
      </div>
      <p className="table-note">
        {players} players · {r.groups.length} {r.groups.length === 1 ? "level" : "levels"} · stats
        through {through.join(", ")} · Momentum window: {mWindow.label.toLowerCase()}
      </p>
      <nav className="org-jump" aria-label="Levels and affiliates">
        {r.groups.map((g) => (
          <span key={g.level}>
            <a href={`#level-${g.level}`}>{levelById(g.level).short}</a>
            {g.affiliates.map((a) =>
              a.team ? (
                <a key={a.team.id} href={`#team-${a.team.id}`} title={a.team.name}>
                  {a.team.abbreviation}
                </a>
              ) : null,
            )}
          </span>
        ))}
      </nav>
      <OrgLevels groups={r.groups} momentumShort={mWindow.short} />
    </>
  );
}
