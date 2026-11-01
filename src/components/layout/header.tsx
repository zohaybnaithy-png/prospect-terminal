"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ArrowUpRight, Search } from "lucide-react";
const links = [
  ["Market", "/market"],
  ["Players", "/players"],
  ["Teams", "/teams"],
  ["Screener", "/screener"],
  ["News", "/news"],
];
export function Header() {
  const pathname = usePathname();
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link href="/" className="brand" aria-label="Prospect Terminal home">
          <span className="brand-icon">
            <Activity size={24} strokeWidth={2.5} />
          </span>
          <span>
            PROSPECT<span className="brand-sub">TERMINAL</span>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          {links.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className={
                pathname.startsWith(href) ||
                (href === "/market" && pathname === "/")
                  ? "active"
                  : ""
              }
              aria-current={
                pathname.startsWith(href) ||
                (href === "/market" && pathname === "/")
                  ? "page"
                  : undefined
              }
            >
              {label}
            </Link>
          ))}
        </nav>
        <form action="/players" className="global-search">
          <Search size={15} aria-hidden="true" />
          <input
            name="q"
            aria-label="Search demo players"
            placeholder="Search players…"
          />
          <kbd>↵</kbd>
        </form>
        <span className="header-edition">
          NCAA D1 <ArrowUpRight size={13} />
        </span>
      </div>
    </header>
  );
}
