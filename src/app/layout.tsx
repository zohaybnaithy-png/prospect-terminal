import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "Prospect Terminal | The next wave",
    template: "%s | Prospect Terminal",
  },
  description:
    "A baseball prospect intelligence workspace. Foundation preview using entirely fictional development data.",
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
        <div className="demo-ribbon">
          <span className="status-dot" />
          <strong>DEVELOPMENT PREVIEW</strong>
          <span className="ribbon-divider">/</span>
          <span>Fictional players, teams, stats & scores. No live data.</span>
        </div>
        <main id="main" className="main-shell">
          {children}
        </main>
        <footer className="site-footer">
          <Link href="/" className="footer-brand">
            PROSPECT TERMINAL
          </Link>
          <span>Built for the next wave.</span>
          <span className="footer-note">
            FOUNDATION v0.1 <span>·</span> DEMO DATA ONLY
          </span>
        </footer>
      </body>
    </html>
  );
}
