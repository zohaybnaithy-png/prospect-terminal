import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * The site's only `Link` (ESLint forbids importing `next/link` elsewhere). Identical to Next.js's
 * `Link`, except that prefetching is OFF unless a caller opts in with `prefetch`.
 *
 * Why (docs/VERCEL.md, *Prefetching*): every page is rendered per request, so each prefetch is a
 * server request. A page view used to issue 50–65 of them (one per visible player link,
 * docs/TRAFFIC.md), which on Vercel Hobby are function invocations and edge requests against the
 * monthly caps, and on any host server work. Navigation still works the same: a click fetches the
 * page then, from the CDN cache when it is warm.
 */
export default function Link({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />;
}
