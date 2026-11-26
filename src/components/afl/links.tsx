import Link from "@/components/ui/app-link";
import type { AflOrganization, AflTeam } from "@/services/afl/types";
import type { LevelId } from "@/services/players/levels";
import { orgHref } from "@/services/orgs/slug";

/**
 * Player-first context links. A team belongs to one level, so its link opens the player directory
 * filtered to that team (and level when known). An organization spans levels, so its link opens
 * the organization page (T-204): its players at every level, by affiliate.
 */
export const AflTeamLink = ({
  team,
  full = false,
  level,
}: {
  team: AflTeam;
  full?: boolean;
  level?: LevelId;
}) => (
  <Link
    href={`/players?${level ? `level=${level}&` : ""}team=${team.id}`}
    title={`${team.name} — players`}
  >
    {full ? team.name : team.abbreviation}
  </Link>
);

export const AflOrganizationLink = ({
  organization,
  full = false,
}: {
  organization: AflOrganization;
  full?: boolean;
}) => (
  <Link
    href={orgHref(organization)}
    title={`${organization.name} — players at every level, by affiliate`}
  >
    {full ? organization.name : organization.abbreviation}
  </Link>
);
