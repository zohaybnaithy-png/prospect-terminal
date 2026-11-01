"use client";
import { useState } from "react";
import { sortByValue } from "@/lib/table-sort";
import type { Catalog, Player, TimeWindow, PlayerType } from "@/types/baseball";
import {
  DataTable,
  type Column,
  type TableSort,
} from "@/components/ui/data-table";
import {
  PlayerLink,
  OrganizationLink,
  TeamLink,
  ContextLink,
} from "@/components/ui/entity-links";
import { Grade, Momentum } from "@/components/ui/primitives";
import { ageOn, average, innings, era } from "@/lib/format";
import { DEMO_AS_OF } from "@/data/demo";
export function PlayerTable({
  players,
  catalog,
  window = "14d",
  type = "all",
  expanded = false,
}: {
  players: Player[];
  catalog: Catalog;
  window?: TimeWindow;
  type?: PlayerType;
  expanded?: boolean;
}) {
  const [sort, setSort] = useState<TableSort | null>(null);
  const sample = (p: Player) => p.performance[window];
  const columns: Column<Player>[] = [
    {
      key: "rank",
      label: "#",
      title:
        "Reference position in the selected demo order (retained when sorting a column)",
      numeric: true,
      render: (p) => players.indexOf(p) + 1,
    },
    {
      key: "player",
      label: "Player",
      render: (p) => <PlayerLink player={p} />,
      sortValue: (p) => p.name,
    },
    {
      key: "org",
      label: "Org",
      title: "Parent organization (fictional)",
      render: (p) => (
        <OrganizationLink
          organization={catalog.organizations.find(
            (o) => o.id === p.organizationId,
          )!}
        />
      ),
    },
    {
      key: "team",
      label: "Team",
      render: (p) => (
        <TeamLink team={catalog.teams.find((t) => t.id === p.teamId)!} />
      ),
    },
    {
      key: "level",
      label: "Level",
      render: (p) => (
        <ContextLink
          context={catalog.contexts.find(
            (c) =>
              c.id === catalog.teams.find((t) => t.id === p.teamId)!.contextId,
          )!}
        />
      ),
    },
    { key: "position", label: "Pos", render: (p) => p.position },
    {
      key: "age",
      label: "Age",
      numeric: true,
      render: (p) => ageOn(p.birthDate, DEMO_AS_OF),
      sortValue: (p) => ageOn(p.birthDate, DEMO_AS_OF),
    },
  ];
  const battingColumns: Column<Player>[] = [
    {
      key: "ab",
      label: "AB",
      title: "At bats",
      numeric: true,
      render: (p) => sample(p).batting?.atBats ?? "—",
      sortValue: (p) => sample(p).batting?.atBats ?? null,
    },
    {
      key: "h",
      label: "H",
      title: "Hits",
      numeric: true,
      render: (p) => sample(p).batting?.hits ?? "—",
      sortValue: (p) => sample(p).batting?.hits ?? null,
    },
    {
      key: "2b",
      label: "2B",
      numeric: true,
      render: (p) => sample(p).batting?.doubles ?? "—",
      sortValue: (p) => sample(p).batting?.doubles ?? null,
    },
    {
      key: "3b",
      label: "3B",
      numeric: true,
      render: (p) => sample(p).batting?.triples ?? "—",
      sortValue: (p) => sample(p).batting?.triples ?? null,
    },
    {
      key: "hr",
      label: "HR",
      title: "Home runs",
      numeric: true,
      render: (p) => sample(p).batting?.homeRuns ?? "—",
      sortValue: (p) => sample(p).batting?.homeRuns ?? null,
    },
    {
      key: "avg",
      label: "AVG",
      title: "Batting average",
      numeric: true,
      render: (p) => {
        const b = sample(p).batting;
        return b ? average(b.hits, b.atBats) : "—";
      },
      sortValue: (p) => {
        const b = sample(p).batting;
        return b && b.atBats ? b.hits / b.atBats : null;
      },
    },
    {
      key: "bb",
      label: "BB",
      numeric: true,
      render: (p) => sample(p).batting?.walks ?? "—",
      sortValue: (p) => sample(p).batting?.walks ?? null,
    },
    {
      key: "so",
      label: "SO",
      numeric: true,
      render: (p) => sample(p).batting?.strikeouts ?? "—",
      sortValue: (p) => sample(p).batting?.strikeouts ?? null,
    },
    {
      key: "sb",
      label: "SB",
      numeric: true,
      render: (p) => sample(p).batting?.stolenBases ?? "—",
      sortValue: (p) => sample(p).batting?.stolenBases ?? null,
    },
  ];
  const pitchingColumns: Column<Player>[] = [
    {
      key: "ip",
      label: "IP",
      title: "Innings pitched (outs converted to baseball notation)",
      numeric: true,
      render: (p) => {
        const s = sample(p).pitching;
        return s ? innings(s.outsRecorded) : "—";
      },
      sortValue: (p) => sample(p).pitching?.outsRecorded ?? null,
    },
    {
      key: "era",
      label: "ERA",
      title: "Earned run average",
      numeric: true,
      render: (p) => {
        const s = sample(p).pitching;
        return s ? era(s.earnedRuns, s.outsRecorded) : "—";
      },
      sortValue: (p) => {
        const s = sample(p).pitching;
        return s && s.outsRecorded
          ? (s.earnedRuns * 27) / s.outsRecorded
          : null;
      },
    },
    {
      key: "k",
      label: "K",
      title: "Pitching strikeouts",
      numeric: true,
      render: (p) => sample(p).pitching?.strikeouts ?? "—",
      sortValue: (p) => sample(p).pitching?.strikeouts ?? null,
    },
    {
      key: "pbb",
      label: "BB",
      title: "Pitching walks",
      numeric: true,
      render: (p) => sample(p).pitching?.walks ?? "—",
      sortValue: (p) => sample(p).pitching?.walks ?? null,
    },
    {
      key: "ha",
      label: "H",
      title: "Hits allowed",
      numeric: true,
      render: (p) => sample(p).pitching?.hitsAllowed ?? "—",
      sortValue: (p) => sample(p).pitching?.hitsAllowed ?? null,
    },
    {
      key: "er",
      label: "ER",
      title: "Earned runs",
      numeric: true,
      render: (p) => sample(p).pitching?.earnedRuns ?? "—",
      sortValue: (p) => sample(p).pitching?.earnedRuns ?? null,
    },
    {
      key: "whip",
      label: "WHIP",
      title: "Walks + hits per inning pitched",
      numeric: true,
      render: (p) => {
        const s = sample(p).pitching;
        return s && s.outsRecorded
          ? (((s.walks + s.hitsAllowed) * 3) / s.outsRecorded).toFixed(2)
          : "—";
      },
      sortValue: (p) => {
        const s = sample(p).pitching;
        return s && s.outsRecorded
          ? ((s.walks + s.hitsAllowed) * 3) / s.outsRecorded
          : null;
      },
    },
  ];
  columns.push(
    ...(type === "hitters"
      ? expanded
        ? battingColumns
        : battingColumns.filter((c) =>
            ["ab", "h", "hr", "avg", "so"].includes(c.key),
          )
      : type === "pitchers"
        ? expanded
          ? pitchingColumns
          : pitchingColumns.slice(0, 4)
        : [
            ...battingColumns.filter((c) => ["avg", "hr"].includes(c.key)),
            ...pitchingColumns.slice(0, 3),
          ]),
  );
  columns.push(
    {
      key: "grade",
      label: "Grade",
      title: "Illustrative Prospect Grade (0–100)",
      numeric: true,
      render: (p) => <Grade value={p.grade} />,
      sortValue: (p) => p.grade,
    },
    {
      key: "momentum",
      label: "Mom",
      title:
        "Illustrative Momentum (signed, as of snapshot; not recalculated by selected window)",
      numeric: true,
      render: (p) => <Momentum value={p.momentum} />,
      sortValue: (p) => p.momentum,
    },
  );
  const column = columns.find((c) => c.key === sort?.key);
  const rows =
    sort && column?.sortValue
      ? sortByValue(players, column.sortValue, sort.direction)
      : players;
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(p) => p.id}
      caption={`Fictional ${type} performance for ${window}; Grade and Momentum are illustrative snapshot values`}
      sort={sort}
      onSort={(key) =>
        setSort((old) => ({
          key,
          direction:
            old?.key === key && old.direction === "desc" ? "asc" : "desc",
        }))
      }
    />
  );
}
