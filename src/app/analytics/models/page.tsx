import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageHeading } from "@/components/ui/primitives";
import { getAflData } from "@/services/afl";
import { AflDataNotice } from "@/components/afl/data-notice";
import { ModelComparisonView } from "@/components/analytics/model-comparison";
import { analyticsDebugEnabled } from "@/analytics/debug";
import {
  MOMENTUM_WINDOWS,
  MOMENTUM_WINDOW_IDS,
  type MomentumWindow,
} from "@/analytics/config";
import { compareModels } from "@/analytics/engine";
import { analyticsContextFor } from "@/analytics/views";
import { shortDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Momentum model comparison (development)",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ModelsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!analyticsDebugEnabled()) notFound();
  return (
    <>
      <PageHeading
        eyebrow="Development review"
        title="Momentum model comparison"
        description="Momentum weightings run over the same ingested AFL data. Balanced is the V1 default used across the site; Production-heavy and Skills-heavy are kept here for comparison only."
      />
      <Suspense fallback={<p className="empty-state" aria-busy="true">Running candidate models…</p>}>
        <Comparison searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Comparison({ searchParams }: { searchParams: SearchParams }) {
  const [data, params] = await Promise.all([getAflData(), searchParams]);
  const requested = typeof params.window === "string" ? params.window : "";
  const window: MomentumWindow =
    MOMENTUM_WINDOW_IDS.find((w) => w === requested) ?? "14d";
  if (data.status !== "ok") return <AflDataNotice status={data.status} />;
  const ctx = analyticsContextFor(data.snapshot);
  const cmp = compareModels(ctx, window, 20);
  return (
    <>
      <nav className="button-group" aria-label="Comparison window">
        {MOMENTUM_WINDOW_IDS.map((w) => (
          <Link key={w} href={`/analytics/models?window=${w}`} className="button-link" aria-current={w === window ? "page" : undefined}>
            {MOMENTUM_WINDOWS[w].short}
          </Link>
        ))}
      </nav>
      <p className="table-note">
        {cmp.asOf ? `Through ${shortDate(cmp.asOf)}. ` : "No completed games. "}
        {cmp.qualified.hitter} hitters and {cmp.qualified.pitcher} pitchers meet
        the {MOMENTUM_WINDOWS[window].short} list minimums. The same output is
        available offline with <code>npm run analytics:compare</code>.
      </p>
      <ModelComparisonView cmp={cmp} />
    </>
  );
}
