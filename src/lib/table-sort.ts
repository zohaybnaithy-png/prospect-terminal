/** Stable descriptive column sort; unavailable stats stay last in both directions. */
export function sortByValue<T>(
  rows: T[],
  value: (row: T) => number | string | null,
  direction: "asc" | "desc",
): T[] {
  return [...rows].sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    return (
      (typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv)) * (direction === "asc" ? 1 : -1)
    );
  });
}
