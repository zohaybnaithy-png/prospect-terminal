"use client";

import { useLinkStatus } from "@/components/ui/app-link";

/**
 * Inline "this link is loading" hint (docs/VERCEL.md, *Navigation*). Place it inside a `Link`; it
 * reflects that link's pending state (Next.js `useLinkStatus`, stable since 15.3). Purely visual
 * and client-side: no request, no server change.
 *
 * Always rendered with a fixed, absolutely positioned box, so toggling it never shifts layout.
 * It only becomes visible after a short delay (globals.css `.link-hint`), so cached navigations
 * (a few tens of milliseconds) never flash it. Hidden from assistive technology: the link text
 * already names the destination, and the page title changes once the navigation completes.
 */
export function LinkPendingHint() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className="link-hint" data-pending={pending ? "true" : "false"} />;
}
