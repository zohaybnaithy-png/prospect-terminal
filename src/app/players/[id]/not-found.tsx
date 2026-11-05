import Link from "next/link";

export default function PlayerNotFound() {
  return (
    <div className="page-heading not-found">
      <p className="eyebrow">Player not found</p>
      <h1>We couldn&apos;t find that player</h1>
      <p>
        The link may be outdated, or the player has no recorded games in the
        current data.
      </p>
      <form action="/players" className="not-found-search">
        <input name="q" aria-label="Search players" placeholder="Search players" />
        <button type="submit">Search</button>
      </form>
      <p>
        <Link href="/players">Browse all players →</Link>
      </p>
    </div>
  );
}
