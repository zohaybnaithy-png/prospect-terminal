import type { PerformanceLine, Catalog } from "@/types/baseball";
import { DataTable, type Column } from "@/components/ui/data-table";
import { TeamLink } from "@/components/ui/entity-links";
import { average, innings, era } from "@/lib/format";
export interface StatRow extends PerformanceLine {
  id: string;
  label: string;
  teamId: string;
}
export function StatTable({
  rows,
  catalog,
  type,
}: {
  rows: StatRow[];
  catalog: Catalog;
  type: "batting" | "pitching";
}) {
  const columns: Column<StatRow>[] = [
    { key: "sample", label: "Sample", render: (r) => r.label },
    {
      key: "team",
      label: "Team",
      render: (r) => (
        <TeamLink team={catalog.teams.find((t) => t.id === r.teamId)!} full />
      ),
    },
  ];
  if (type === "batting")
    columns.push(
      ...(
        [
          ["atBats", "AB"],
          ["hits", "H"],
          ["doubles", "2B"],
          ["triples", "3B"],
          ["homeRuns", "HR"],
          ["walks", "BB"],
          ["strikeouts", "SO"],
          ["stolenBases", "SB"],
        ] as const
      ).map(([key, label]) => ({
        key,
        label,
        numeric: true,
        render: (r: StatRow) => r.batting?.[key] ?? "—",
      })),
      {
        key: "avg",
        label: "AVG",
        numeric: true,
        render: (r) =>
          r.batting ? average(r.batting.hits, r.batting.atBats) : "—",
      },
    );
  else
    columns.push(
      {
        key: "ip",
        label: "IP",
        numeric: true,
        render: (r) => (r.pitching ? innings(r.pitching.outsRecorded) : "—"),
      },
      {
        key: "era",
        label: "ERA",
        numeric: true,
        render: (r) =>
          r.pitching
            ? era(r.pitching.earnedRuns, r.pitching.outsRecorded)
            : "—",
      },
      ...(
        [
          ["hitsAllowed", "H"],
          ["earnedRuns", "ER"],
          ["strikeouts", "K"],
          ["walks", "BB"],
        ] as const
      ).map(([key, label]) => ({
        key,
        label,
        numeric: true,
        render: (r: StatRow) => r.pitching?.[key] ?? "—",
      })),
    );
  return (
    <DataTable
      rows={rows.filter((r) => r[type])}
      columns={columns}
      rowKey={(r) => r.id}
      caption={`Fictional player ${type} statistics; season rows are team stints, not combined totals`}
    />
  );
}
