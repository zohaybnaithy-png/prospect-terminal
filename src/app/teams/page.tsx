import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { TeamTable } from "@/components/data/team-table";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Affiliates & fall teams" };
export default async function TeamsPage() {
  const catalog = await prospectRepository.catalog();
  return (
    <>
      <PageHeading
        title="Affiliates & fall teams"
        description="Fictional professional-development teams. Affiliates have a parent organization; fall teams can include players from multiple organizations."
      />
      <TeamTable teams={catalog.teams} catalog={catalog} />
    </>
  );
}
