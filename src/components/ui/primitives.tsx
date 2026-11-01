import type { ReactNode } from "react";
import { signed } from "@/lib/format";
export function SectionTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
export function Momentum({ value }: { value: number }) {
  return (
    <span className={value < 0 ? "negative" : "positive"}>{signed(value)}</span>
  );
}
export function Grade({ value }: { value: number }) {
  return <span title="Illustrative Prospect Grade, 0–100">{value}</span>;
}
export function PageHeading({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description: string;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
