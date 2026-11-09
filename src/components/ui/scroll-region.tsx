import type { ReactNode } from "react";

/**
 * Wrapper for content that can scroll (wide or tall tables). It is a named, focusable region so
 * keyboard users can scroll it with the arrow keys even when it holds no links or buttons
 * (WCAG 2.1.1; axe `scrollable-region-focusable`). Use it for every `.table-scroll`.
 */
export function ScrollRegion({
  label,
  className,
  children,
}: {
  /** Accessible name, e.g. the table caption. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `table-scroll ${className}` : "table-scroll"}
      tabIndex={0}
      role="region"
      aria-label={label}
    >
      {children}
    </div>
  );
}
