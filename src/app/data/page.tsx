import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Data" };
export default async function DataPage() {
  return (
    <>
      <PageHeading
        title="Minor league data"
        description="Hitting and pitching leaderboards. Sort statistical columns to explore the numbers. All samples are fictional; splits, historical queries, and downloads are future work."
      />
      <PerformanceExplorer
        catalog={await prospectRepository.catalog()}
        variant="data"
        title="Statistical leaderboards"
      />
    </>
  );
}
