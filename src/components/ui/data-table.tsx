import type { ReactNode } from "react";
export interface Column<T> {
  key: string;
  label: string;
  title?: string;
  numeric?: boolean;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null;
}
export interface TableSort {
  key: string;
  direction: "asc" | "desc";
}
/** Presentation-only primitive usable in server and client components. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  sort,
  onSort,
  emptyMessage = "No rows to show.",
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  sort?: TableSort | null;
  onSort?: (key: string) => void;
  emptyMessage?: string;
}) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${caption}; scroll horizontally for more columns`}
    >
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                scope="col"
                key={c.key}
                className={c.numeric ? "numeric" : ""}
                title={c.title}
                aria-sort={
                  sort?.key === c.key
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                {onSort && c.sortValue ? (
                  <button type="button" onClick={() => onSort(c.key)}>
                    {c.label}
                    <span aria-hidden="true">
                      {sort?.key === c.key
                        ? sort.direction === "asc"
                          ? " ↑"
                          : " ↓"
                        : " ↕"}
                    </span>
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? "numeric" : ""}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty-state">{emptyMessage}</div>}
    </div>
  );
}
