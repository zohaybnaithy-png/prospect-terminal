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
        <form action="/players" className="global-search">
          <Search size={16} aria-hidden="true" />
          <input
            name="q"
            aria-label="Search player or team"
            placeholder="Search player or team"
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
