import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
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
  const Icon = value < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <span className={`momentum ${value < 0 ? "negative" : "positive"}`}>
      <Icon size={14} aria-hidden="true" />
      {signed(value)}
    </span>
  );
}
export function Grade({ value }: { value: number }) {
  return (
    <span className="grade">
      <strong>{value}</strong>
      <span className="grade-track" aria-hidden="true">
        <span style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}
export function TeamMark({
  abbreviation,
  color,
  small = false,
}: {
  abbreviation: string;
  color: string;
  small?: boolean;
}) {
  return (
    <span className={`team-mark ${color} ${small ? "small" : ""}`}>
      {abbreviation}
    </span>
  );
}
export function PageHeading({
  title,
  description,
  eyebrow = "THE PROSPECT WORKSPACE",
}: {
  title: string;
  description: string;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>
        {title}
        <span className="title-dot">.</span>
      </h1>
      <p>{description}</p>
    </div>
  );
}
