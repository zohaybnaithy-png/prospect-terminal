"use client";
import Link from "@/components/ui/app-link";
import { LinkPendingHint } from "@/components/ui/link-pending-hint";
import Image from "next/image";
import prospectLogo from "../../../prospect-terminal-logo.png";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { PlayerTypeahead } from "./player-typeahead";
const links = [
  ["Home", "/"],
  ["Players", "/players"],
  ["Orgs", "/orgs"],
  ["Trends", "/trends"],
  ["Data", "/data"],
  ["Watchlist", "/watchlist"],
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
          <PlayerTypeahead />
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
              <LinkPendingHint />
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
