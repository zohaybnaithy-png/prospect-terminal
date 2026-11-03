import Link from "next/link";

export const PlayerLink = ({
  player,
}: {
  player: { id: string; name: string };
}) => (
  <Link className="player-name" href={`/players/${player.id}`}>
    {player.name}
  </Link>
);
