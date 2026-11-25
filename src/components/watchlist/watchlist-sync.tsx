"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/app-link";
import { watchlistHref } from "@/services/watchlist/query";
import { useWatchlist } from "./use-watchlist";

/**
 * Connects the server-rendered `/watchlist?ids=` page to this browser's stars. The page itself is
 * the same for every visitor with the same URL; this component replaces the URL with the stored
 * list (sorted, canonical) whenever they differ, e.g. on arrival at `/watchlist` or after a star
 * is removed, and explains the empty and storage-blocked states. The current table stays visible
 * while the new one loads.
 */
export function WatchlistSync({ urlIds }: { urlIds: string[] }) {
  const state = useWatchlist();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = watchlistHref(urlIds);
  const target = state?.status === "ready" ? watchlistHref(state.ids) : null;
  const stale = target !== null && target !== current;

  useEffect(() => {
    if (stale) startTransition(() => router.replace(target, { scroll: false }));
  }, [stale, target, router]);

  if (state === null)
    return urlIds.length ? null : (
      <p className="placeholder-panel watch-status" role="status">
        Checking this browser for starred players…
      </p>
    );

  if (state.status === "unavailable")
    return (
      <div className="afl-notice compact watch-status" role="status">
        <p>
          <strong>This browser is blocking site storage, so the watchlist can&apos;t be saved here.</strong>{" "}
          Stars are kept only in this browser&apos;s local storage — there are no accounts and nothing is
          sent to a server — so with storage blocked (for example by a privacy setting or some private
          windows) no players can be starred.
          {urlIds.length > 0 && " The players below come from the link you opened."}
        </p>
      </div>
    );

  if (stale || pending)
    return (
      <p className="placeholder-panel watch-status" role="status" aria-busy="true">
        {state.ids.length ? `Loading ${state.ids.length} starred ${state.ids.length === 1 ? "player" : "players"}…` : "Updating…"}
      </p>
    );

  if (state.ids.length === 0)
    return (
      <div className="placeholder-panel watch-status watch-empty" role="status">
        <p>
          <strong>No players on your watchlist yet.</strong> Choose the star beside a player in{" "}
          <Link href="/players">Players</Link> or <strong>Add to watchlist</strong> on a profile.
        </p>
        <p>
          Stars are saved only in this browser (local storage): no account, no cookies, nothing stored on
          a server. They don&apos;t follow you to other browsers or devices, and clearing this site&apos;s
          data removes them.
        </p>
      </div>
    );

  return null;
}
