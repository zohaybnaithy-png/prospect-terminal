export const signed = (value: number) =>
  `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
export const average = (hits: number, atBats: number) =>
  atBats ? (hits / atBats).toFixed(3).replace(/^0/, "") : "—";
export const innings = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
export const era = (runs: number, outs: number) =>
  outs ? ((runs * 27) / outs).toFixed(2) : "—";
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
