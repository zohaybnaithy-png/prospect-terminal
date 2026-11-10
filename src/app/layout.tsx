import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ScoreStrip, ScoreStripFallback } from "@/components/home/score-strip";
import { Header } from "@/components/layout/header";
import { metadataBase } from "@/lib/site-url";
import "./globals.css";
/**
 * Request-time metadata so `metadataBase` (the origin of canonical URLs) comes from the server's
 * `PT_SITE_URL`, never from the request's Host header (src/lib/site-url.ts).
 */
export const generateMetadata = (): Metadata => ({
  metadataBase: metadataBase(),
  title: {
    default: "Prospect Terminal — prospect performance and Momentum",
    template: "%s | Prospect Terminal",
  },
  description:
    "Player-first prospect analytics: trending prospects, Momentum, game logs and scouting-style player profiles built on real 2026 Minor League Baseball (Triple-A to Single-A) and Arizona Fall League data.",
});
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
        <main id="main" className="main-shell">
          {children}
        </main>
        <footer className="site-footer">
          <Link href="/">Prospect Terminal</Link>
          <span>
            2026 MiLB (Triple-A to Single-A) and Arizona Fall League data via the MLB Stats API (development
            use). Momentum measures recent change, not overall quality.
          </span>
          <Link href="/players">Players</Link>
          <Link href="/trends">Trends</Link>
          <Link href="/data">Data &amp; methodology</Link>
        </footer>
      </body>
    </html>
  );
}
