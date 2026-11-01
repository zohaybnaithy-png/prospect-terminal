import type { Metadata } from "next";
import { MarketDashboard } from "@/components/market/market-dashboard";
export const metadata: Metadata = { title: "Market" };
export default function MarketPage() {
  return <MarketDashboard />;
}
