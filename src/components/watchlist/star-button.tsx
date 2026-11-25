"use client";
import { useState } from "react";
import { Star } from "lucide-react";
import { toggleInBrowser } from "@/lib/watchlist-storage";
import { WATCHLIST_MAX } from "@/services/watchlist/query";
import { useWatchlist } from "./use-watchlist";

const MESSAGES = {
  full: `Watchlist full (${WATCHLIST_MAX} players) — remove one first.`,
  unavailable: "Couldn't save: this browser is blocking site storage.",
} as const;

/**
 * Star toggle for one player (T-202). The server and the first client render show the neutral
 * "not starred" state; the stored state appears right after hydration. `icon` is the compact
 * directory/table form, `labelled` the profile form with visible text.
 */
export function WatchlistStar({
  playerId,
  name,
  variant = "icon",
}: {
  playerId: string;
  name: string;
  variant?: "icon" | "labelled";
}) {
  const state = useWatchlist();
  const [message, setMessage] = useState<string | null>(null);
  const id = playerId.toLowerCase();
  const unavailable = state?.status === "unavailable";
  const starred = state?.status === "ready" && state.ids.includes(id);
  const onClick = () => {
    if (unavailable) {
      setMessage(MESSAGES.unavailable);
      return;
    }
    const r = toggleInBrowser(id);
    setMessage(r === "full" || r === "unavailable" ? MESSAGES[r] : null);
  };
  const visible = unavailable ? "Watchlist unavailable" : starred ? "Remove from watchlist" : "Add to watchlist";
  return (
    <>
      <button
        type="button"
        className={`watch-star ${variant}`}
        aria-pressed={starred}
        aria-disabled={unavailable || undefined}
        data-state={state === null ? "pending" : unavailable ? "unavailable" : starred ? "on" : "off"}
        title={unavailable ? "This browser is blocking site storage, so stars can't be saved" : undefined}
        onClick={onClick}
      >
        <Star aria-hidden="true" size={variant === "icon" ? 14 : 13} fill={starred ? "currentColor" : "none"} strokeWidth={2} />
        {unavailable ? (
          variant === "icon" ? (
            <span className="sr-only">Watchlist unavailable for {name}: this browser is blocking site storage</span>
          ) : (
            <span>
              {visible}
              <span className="sr-only"> for {name}: this browser is blocking site storage</span>
            </span>
          )
        ) : variant === "icon" ? (
          <span className="sr-only">
            {starred ? "Remove" : "Add"} {name} {starred ? "from" : "to"} watchlist
          </span>
        ) : (
          <span>
            {starred ? "Remove" : "Add"}
            <span className="sr-only"> {name}</span> {starred ? "from" : "to"} watchlist
          </span>
        )}
      </button>
      {message && (
        <span className="watch-message" role="status">
          {message}
        </span>
      )}
    </>
  );
}
