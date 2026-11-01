import type { Metadata } from "next";
import { PageHeading } from "@/components/ui/primitives";
import { PerformanceExplorer } from "@/components/discovery/performance-explorer";
import { prospectRepository } from "@/services/prospects";
export const metadata: Metadata = { title: "Screener" };
export default async function ScreenerPage() {
  return (
    <>
      <PageHeading
        title="Prospect screener"
        description="Find players by level, organization, team, age, position, Grade, and Momentum. Only fictional demo fields are available."
      />
      <PerformanceExplorer
        catalog={await prospectRepository.catalog()}
        variant="screener"
        title="Screen players"
      />
    </>
  );
}
