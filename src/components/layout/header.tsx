"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
const links = [
  ["Home", "/"],
  ["Players", "/players"],
  ["Organizations", "/organizations"],
  ["Leagues", "/leagues"],
  ["Data", "/data"],
  ["Screener", "/screener"],
  ["News", "/news"],
];
export function Header() {
  const path = usePathname();
  return (
    <header className="site-header">
      <div className="header-top">
        <Link href="/" className="brand" aria-label="Prospect Terminal home">
          <span className="brand-monogram">PT</span>
          <span>
            Prospect Terminal<small>Minor league discovery & development</small>
          </span>
        </Link>
        <form action="/players" className="global-search">
          <Search size={16} aria-hidden="true" />
          <input
            name="q"
            aria-label="Search demo players"
            placeholder="Search players…"
          />
          <button type="submit" aria-label="Submit player search">
            Search
          </button>
        </form>
      </div>
      <nav aria-label="Main navigation">
        {links.map(([label, href]) => {
          const active =
            href === "/"
              ? path === "/" || path === "/market"
              : path.startsWith(href) ||
                (href === "/organizations" && path.startsWith("/teams"));
          return (
            <Link
              key={href}
              href={href}
              className={active ? "active" : ""}
              aria-current={active ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
