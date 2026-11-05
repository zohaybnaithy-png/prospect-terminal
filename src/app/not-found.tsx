import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page-heading not-found">
      <p className="eyebrow">404 · Not found</p>
      <h1>Outside the field of play</h1>
      <p>This page doesn&apos;t exist or has moved.</p>
      <p>
        <Link href="/">Home</Link> · <Link href="/players">Players</Link> ·{" "}
        <Link href="/data">Data &amp; methodology</Link>
      </p>
    </div>
  );
}
