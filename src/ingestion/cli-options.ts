import { z } from "zod";
export function parseIngestionArgs(args: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const toggles = new Set(["apply", "dry-run", "games-only", "rosters-only"]);
  const options = new Set([
    "source",
    "season",
    "from",
    "to",
    "team",
    "record-dir",
  ]);
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
