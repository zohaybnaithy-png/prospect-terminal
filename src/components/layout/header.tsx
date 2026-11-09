"use client";
import Link from "next/link";
import Image from "next/image";
import prospectLogo from "../../../prospect-terminal-logo.png";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
const links = [
  ["Home", "/"],
  ["Players", "/players"],
  ["Trends", "/trends"],
  ["Data", "/data"],
] as const;
export function Header() {
  const path = usePathname();
  return (
    <header className="site-header">
      <div className="header-top">
        <Link href="/" className="brand" aria-label="Prospect Terminal home">
          <span className="brand-logo">
            <Image
              src={prospectLogo}
              alt=""
              className="brand-logo-image"
              sizes="90px"
              preload
            />
          </span>
          <span>Prospect Terminal</span>
        </Link>
        <form action="/players" className="global-search" role="search">
          <Search size={16} aria-hidden="true" />
          <input
            name="q"
            aria-label="Search players, teams or organizations"
            placeholder="Search players, teams, orgs"
          />
          <button type="submit" aria-label="Submit player search">
            Search
          </button>
        </form>
      </div>
      <nav aria-label="Main navigation">
        {links.map(([label, href]) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
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
