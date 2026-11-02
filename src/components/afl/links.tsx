import Link from "next/link";
import type { AflOrganization, AflTeam } from "@/services/afl/types";

/** Player-first: team and organization context links open the filtered AFL player directory. */
export const AflTeamLink = ({
  team,
  full = false,
}: {
  team: AflTeam;
  full?: boolean;
}) => (
  <Link href={`/players?team=${team.id}`} title={`${team.name} — AFL players`}>
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
    title={`${organization.name} — AFL players from this organization`}
  >
    {full ? organization.name : organization.abbreviation}
  </Link>
);
