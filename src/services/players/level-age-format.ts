/** Client-safe display for age relative to level (T-401). */

/** "+1.4" / "−0.8" / "0.0" (a true minus sign, as elsewhere in the tables); "—" when unknown. */
export const formatAgeVsLevel = (d: number | null) =>
  d === null ? "—" : d > 0 ? `+${d.toFixed(1)}` : d < 0 ? `−${Math.abs(d).toFixed(1)}` : "0.0";
