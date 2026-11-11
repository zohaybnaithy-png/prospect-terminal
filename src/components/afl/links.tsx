import Link from "@/components/ui/app-link";
import type { AflOrganization, AflTeam } from "@/services/afl/types";
import type { LevelId } from "@/services/players/levels";

/**
 * Player-first: team and organization context links open the filtered player directory. A team
 * belongs to one level, so its link scopes the directory to that level when known; an
 * organization spans levels, so its link opens all levels.
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
    href={`/players?org=${organization.id}`}
    title={`${organization.name} — players from this organization at every level`}
  >
    {full ? organization.name : organization.abbreviation}
  </Link>
);
