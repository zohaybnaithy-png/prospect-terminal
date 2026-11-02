import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ScoreStrip, ScoreStripFallback } from "@/components/home/score-strip";
import { Header } from "@/components/layout/header";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "Prospect Terminal | MiLB discovery",
    template: "%s | Prospect Terminal",
  },
  description:
    "Discover minor league performers and follow player development. Real 2026 Arizona Fall League statistics alongside clearly labeled demo content; no scoring models yet.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Header />
        <Suspense fallback={<ScoreStripFallback />}>
          <ScoreStrip />
        </Suspense>
        <div className="demo-ribbon">
          <strong>AFL 2026</strong> Scores, the AFL player directory and player
          profiles use real ingested Arizona Fall League data. News, highlights,
          call-ups, Prospect Grades, Momentum and the fictional organizations
          are demo placeholders.
        </div>
        <main id="main" className="main-shell">
          {children}
        </main>
        <footer className="site-footer">
          <Link href="/">Prospect Terminal</Link>
          <span>MiLB-first · Player-first · Development preview</span>
          <Link href="/teams">Affiliate directory</Link>
          <Link href="/data">Statistical data</Link>
          <Link href="/highlights">Highlight previews</Link>
        </footer>
      </body>
    </html>
  );
}
