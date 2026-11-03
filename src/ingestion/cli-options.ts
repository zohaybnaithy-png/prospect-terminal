import { z } from "zod";
/** Shared --flag / --key=value / --key value tokenizer; unknown or repeated options throw. */
function tokenize(args: string[], toggles: Set<string>, options: Set<string>) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--"))
      throw new Error("Expected --option arguments");
    const [key, ...rest] = args[i].slice(2).split("=");
    if (values.has(key) || flags.has(key)) throw new Error(`Repeated --${key}`);
    if (toggles.has(key)) {
      if (rest.length) throw new Error(`--${key} does not take a value`);
      flags.add(key);
    } else if (options.has(key)) {
      const value = rest.length ? rest.join("=") : args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for --${key}`);
      values.set(key, value);
    } else throw new Error(`Unknown --${key}`);
  }
  return { values, flags };
}
export function parseIngestionArgs(args: string[]) {
  const { values, flags } = tokenize(
    args,
    new Set(["apply", "dry-run", "games-only", "rosters-only"]),
    new Set(["source", "season", "from", "to", "team", "record-dir"]),
  );
  if (flags.has("apply") && flags.has("dry-run"))
    throw new Error("Choose --apply or --dry-run");
  if (flags.has("games-only") && flags.has("rosters-only"))
    throw new Error("Choose games-only or rosters-only");
  const source = z
    .enum(["fixture", "live"])
    .parse(values.get("source") ?? "fixture");
  const season = z.coerce
    .number()
    .int()
    .min(1900)
    .max(2200)
    .parse(values.get("season") ?? "2026");
  const team = values.has("team")
    ? z.coerce.number().int().positive().parse(values.get("team"))
    : undefined;
  const from = values.has("from")
      ? z.iso.date().parse(values.get("from"))
      : undefined,
    to = values.has("to") ? z.iso.date().parse(values.get("to")) : undefined;
  if (from && to && from > to) throw new Error("--from must not be after --to");
  if (
    source === "fixture" &&
    (season !== 2026 ||
      from ||
      to ||
      team ||
      flags.has("games-only") ||
      flags.has("rosters-only") ||
      values.has("record-dir"))
  )
    throw new Error(
      "The bundled fixture supports season 2026 without live filters",
    );
  return {
    source,
    season,
    apply: flags.has("apply"),
    from,
    to,
    team,
    recordDir: values.get("record-dir"),
    mode: flags.has("games-only")
      ? ("games" as const)
      : flags.has("rosters-only")
        ? ("rosters" as const)
        : ("all" as const),
  };
}

const MILB_LEVEL_ARG = ["aaa", "aa", "high-a", "single-a"] as const;
/**
 * `ingest:milb` options. Defaults: live source, dry run, all four levels, structure + games,
 * 7-day game chunks, 4 concurrent requests.
 */
export function parseMilbArgs(args: string[]) {
  const { values, flags } = tokenize(
    args,
    new Set([
      "apply",
      "dry-run",
      "games-only",
      "rosters-only",
      "incremental",
      "refetch-complete",
    ]),
    new Set([
      "source",
      "season",
      "level",
      "league",
      "team",
      "from",
      "to",
      "chunk-days",
      "concurrency",
      "roster-type",
      "game-types",
      "lookback-days",
      "refetch-window-days",
      "record-dir",
    ]),
  );
  if (flags.has("apply") && flags.has("dry-run"))
    throw new Error("Choose --apply or --dry-run");
  if (flags.has("games-only") && flags.has("rosters-only"))
    throw new Error("Choose games-only or rosters-only");
  const source = z.enum(["fixture", "live"]).parse(values.get("source") ?? "live");
  const season = z.coerce.number().int().min(2005).max(2200).parse(values.get("season") ?? String(new Date().getUTCFullYear()));
  const levelArg = values.get("level") ?? "all";
  const levels =
    levelArg === "all"
      ? [...MILB_LEVEL_ARG]
      : z.array(z.enum(MILB_LEVEL_ARG)).min(1).parse(levelArg.split(","));
  if (new Set(levels).size !== levels.length) throw new Error("Repeated --level");
  const positive = (key: string) =>
    values.has(key) ? z.coerce.number().int().positive().parse(values.get(key)) : undefined;
  const date = (key: string) => (values.has(key) ? z.iso.date().parse(values.get(key)) : undefined);
  const from = date("from"),
    to = date("to");
  if (from && to && from > to) throw new Error("--from must not be after --to");
  for (const d of [from, to])
    if (d && Number(d.slice(0, 4)) !== season)
      throw new Error("Date bounds must belong to the selected season");
  if (flags.has("incremental") && (from || flags.has("rosters-only")))
    throw new Error("--incremental computes --from itself and needs games");
  const chunkDays = z.coerce.number().int().min(1).max(31).parse(values.get("chunk-days") ?? "7");
  const concurrency = z.coerce.number().int().min(1).max(8).parse(values.get("concurrency") ?? "4");
  const lookbackDays = z.coerce.number().int().min(0).max(30).parse(values.get("lookback-days") ?? "3");
  const refetchWindowDays = z.coerce.number().int().min(0).max(60).parse(values.get("refetch-window-days") ?? "3");
  const rosterType = z
    .enum(["fullSeason", "active"])
    .parse(values.get("roster-type") ?? (flags.has("incremental") ? "active" : "fullSeason"));
  const gameTypes = z
    .array(z.enum(["R", "F", "D", "L", "W"]))
    .min(1)
    .parse((values.get("game-types") ?? "R").split(","));
  if (source === "fixture" && (flags.has("apply") || flags.has("incremental") || values.has("record-dir")))
    throw new Error("The synthetic MiLB fixture is an offline dry run only (never applied)");
  return {
    source,
    season,
    levels,
    league: positive("league"),
    team: positive("team"),
    from,
    to,
    apply: flags.has("apply"),
    incremental: flags.has("incremental"),
    refetchComplete: flags.has("refetch-complete"),
    mode: flags.has("games-only")
      ? ("games" as const)
      : flags.has("rosters-only")
        ? ("structure" as const)
        : ("all" as const),
    chunkDays,
    concurrency,
    lookbackDays,
    refetchWindowDays,
    rosterType,
    gameTypes,
    recordDir: values.get("record-dir"),
  };
}
export type MilbArgs = ReturnType<typeof parseMilbArgs>;
