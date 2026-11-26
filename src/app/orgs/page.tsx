import type { Metadata } from "next";
import Link from "@/components/ui/app-link";
import { PageHeading } from "@/components/ui/primitives";
import { DataTable, type Column } from "@/components/ui/data-table";
import { getCompetitionData } from "@/services/competition";
import { orgHref, orgIndex, type OrgSummary } from "@/services/orgs/model";
import { LEVELS } from "@/services/players/levels";
import { AflDataNotice } from "@/components/afl/data-notice";

export const metadata: Metadata = {
  title: "Organizations",
  alternates: { canonical: "/orgs" },
  description: "Every MLB organization's prospects by level and affiliate.",
};

export default async function OrgsPage() {
  const data = await getCompetitionData();
  const heading = (
    <PageHeading
      title="Organizations"
      description="MLB parent organizations with players in the loaded levels. Counts are players with a 2026 line at each level, by their latest source roster observation there."
    />
  );
  if (data.status !== "ok")
    return (
      <>
        {heading}
        <AflDataNotice status={data.status} />
      </>
    );
  const loaded = LEVELS.filter((l) => data.levels.some((ls) => ls.level === l.id));
  const columns: Column<OrgSummary>[] = [
    { key: "org", label: "Organization", render: (s) => <Link href={orgHref(s.org)}>{s.org.name}</Link> },
    { key: "abbr", label: "Abbr", render: (s) => s.org.abbreviation },
    ...loaded.map((l) => ({
      key: l.id,
      label: l.short,
      title: `Players at ${l.label}`,
      numeric: true,
      render: (s: OrgSummary) => s.players[l.id] ?? "—",
    })),
    { key: "total", label: "Players", title: "Distinct players across the loaded levels", numeric: true, render: (s) => s.total },
  ];
  return (
    <>
      {heading}
      <DataTable rows={orgIndex(data.levels)} columns={columns} rowKey={(s) => s.org.id} caption="Organizations and their player counts by level" />
    </>
  );
}
