/** Dependency-free stat formatting, safe for Client Components. Missing values render "—". */
export const formatRate = (value: number | null) =>
  value === null ? "—" : value.toFixed(3).replace(/^0(?=\.)/, "");
export const formatFixed = (value: number | null, digits: number) =>
  value === null ? "—" : value.toFixed(digits);
export const formatPct = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(1)}%`;
export const inningsFromOuts = (outs: number) =>
  `${Math.floor(outs / 3)}.${outs % 3}`;
export const slashLine = (b: {
  avg: number | null;
  obp: number | null;
  slg: number | null;
}) => `${formatRate(b.avg)}/${formatRate(b.obp)}/${formatRate(b.slg)}`;
