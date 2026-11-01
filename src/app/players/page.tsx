import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Players" };
export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [catalog, params] = await Promise.all([
    prospectRepository.catalog(),
    searchParams,
  ]);
  const query = typeof params.q === "string" ? params.q : "";
  return (
    <>
      <PageHeading
        title="Player directory"
        description="Search players, compare recent samples, and follow development across the minors. Fictional demo records only."
      />
      <PerformanceExplorer
        key={query}
        catalog={catalog}
        initial={{ query }}
        variant="directory"
        title="Players & recent performance"
      />
    </>
  );
}
