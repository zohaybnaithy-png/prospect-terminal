import Link from "next/link";
import type {
  Player,
  Team,
  Organization,
  DevelopmentContext,
} from "@/types/baseball";
export const PlayerLink = ({
  player,
}: {
  player: Pick<Player, "id" | "name">;
}) => (
  <Link className="player-name" href={`/players/${player.id}`}>
    {player.name}
  </Link>
);
export const OrganizationLink = ({
  organization,
  full = false,
}: {
  organization: Organization;
  full?: boolean;
}) => (
  <Link
    href={`/organizations/${organization.id}`}
    title={`${organization.name} — fictional organization`}
  >
    {full ? organization.name : organization.abbreviation}
  </Link>
);
export const TeamLink = ({
  team,
  full = false,
}: {
  team: Team;
  full?: boolean;
}) => (
  <Link href={`/teams/${team.id}`} title={team.name}>
    {full ? team.name : team.abbreviation}
  </Link>
);
export const ContextLink = ({ context }: { context: DevelopmentContext }) => (
  <Link href={`/leagues/${context.slug}`} title={context.name}>
    {context.shortName}
  </Link>
);
