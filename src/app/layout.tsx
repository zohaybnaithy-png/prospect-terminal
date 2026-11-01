import type { Metadata } from "next";
import Link from "next/link";
import { ScoreStrip } from "@/components/home/score-strip";
import { Header } from "@/components/layout/header";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "Prospect Terminal | MiLB discovery",
    template: "%s | Prospect Terminal",
  },
  description:
    "Discover minor league performers and follow player development. Fictional demonstration data; no live statistics or scoring models.",
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
        <ScoreStrip />
        <div className="demo-ribbon">
          <strong>DEMO</strong> Fictional players, organizations, teams, scores
          & stories. No live data.
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
