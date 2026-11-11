import Link from "@/components/ui/app-link";
import type { LevelId } from "@/services/players/levels";

/**
 * A player has one profile (one internal UUID) across every level. `level` only chooses which
 * level the profile opens at; without it the profile opens at the player's most recent level.
 */
export const playerHref = (id: string, level?: LevelId) =>
  `/players/${id}${level ? `?level=${level}` : ""}`;

export const PlayerLink = ({
  player,
  level,
}: {
  player: { id: string; name: string };
  level?: LevelId;
}) => (
  <Link className="player-name" href={playerHref(player.id, level)}>
    {player.name}
  </Link>
);
