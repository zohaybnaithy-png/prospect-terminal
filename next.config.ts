import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { cdnCacheEnabled, cdnCacheRules } from "./src/lib/cdn-cache";
import { sourceFingerprint } from "./src/services/competition/views-fingerprint";

/**
 * Former demo-only routes (fictional news, highlights, organizations, leagues, teams, screener)
 * were removed for Showcase V1; old links land on the closest real-data page instead of a 404.
 */
const retired: [string, string][] = [
  ["/market", "/"],
  ["/news", "/"],
  ["/highlights", "/"],
  ["/screener", "/players"],
  ["/organizations/:path*", "/players"],
  ["/teams/:path*", "/players"],
  ["/leagues/:path*", "/players"],
];

/**
 * Security headers for every response. The site loads nothing from other origins (fonts, images,
 * scripts and data are all same-origin), so the policy allows only 'self'. Next.js emits inline
 * scripts (the RSC payload) and Recharts sets inline styles, hence 'unsafe-inline' for those two;
 * a nonce-based policy would make every page dynamic for little gain on a site without user
 * accounts or user-generated content. Development also needs 'unsafe-eval' (React debugging).
 * HSTS is sent by the HTTPS-terminating host (see docs/DEPLOYMENT.md), not here, so plain-HTTP
 * local runs are unaffected.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/**
 * Build-time data snapshot (docs/VERCEL.md). With `PT_DATA_SOURCE=snapshot` the server reads levels
 * from files written by `npm run snapshot:export`; they must be inside the project so file tracing
 * can bundle them with every server function, and they must exist when the build runs: a snapshot
 * build without a snapshot fails here instead of deploying a site with no data.
 */
const snapshotMode = () => process.env.PT_DATA_SOURCE?.trim() === "snapshot";
const snapshotRelDir = () =>
  path.relative(process.cwd(), path.resolve(process.cwd(), process.env.PT_SNAPSHOT_DIR?.trim() || ".data-snapshot"));

function snapshotTracing(phase: string): NextConfig["outputFileTracingIncludes"] {
  if (!snapshotMode()) return undefined;
  const dir = snapshotRelDir();
  if (!dir || dir.startsWith("..") || path.isAbsolute(dir))
    throw new Error("PT_SNAPSHOT_DIR must be a directory inside the project for a snapshot build");
  if (phase === PHASE_PRODUCTION_BUILD && !existsSync(path.join(dir, "manifest.json")))
    throw new Error(`PT_DATA_SOURCE=snapshot but ${dir}/manifest.json is missing: run npm run snapshot:export first (npm run build:vercel does)`);
  return { "/**/*": [`./${dir.split(path.sep).join("/")}/**/*`] };
}

/**
 * Precomputed view models (docs/VERCEL.md, *Precomputed view models*). A snapshot build carries
 * the fingerprint of the source it was built from (`PT_SOURCE_FINGERPRINT`, inlined at build;
 * src/services/competition/views-fingerprint.ts); the server uses a snapshot's views only when
 * they were computed by that same source, and computes live otherwise. A snapshot build whose
 * views came from different source fails here, so a stale `snapshot:views` is caught at build
 * time instead of silently disabling the views. Other builds carry nothing.
 */
function snapshotViewsEnv(phase: string): Record<string, string> | undefined {
  if (!snapshotMode() || (phase !== PHASE_PRODUCTION_BUILD && phase !== PHASE_DEVELOPMENT_SERVER)) return undefined;
  const fingerprint = sourceFingerprint(process.cwd());
  const manifest = path.join(snapshotRelDir(), "views", "manifest.json");
  if (phase === PHASE_PRODUCTION_BUILD && existsSync(manifest)) {
    let built: unknown;
    try {
      built = (JSON.parse(readFileSync(manifest, "utf8")) as { sourceFingerprint?: unknown }).sourceFingerprint;
    } catch {
      throw new Error(`${manifest} is unreadable: rerun npm run snapshot:views (npm run build:vercel does)`);
    }
    if (built !== fingerprint)
      throw new Error(`precomputed views in ${manifest} were computed from different source code: rerun npm run snapshot:views (npm run build:vercel does)`);
  }
  return { PT_SOURCE_FINGERPRINT: fingerprint };
}

/**
 * Client router cache for dynamic pages (docs/VERCEL.md, *Navigation*). Every page is rendered per
 * request, and Next.js 16 by default keeps a visited dynamic page in the browser's router cache
 * for 0 s, so every click, revisits included, was a server request (on Vercel, an uncached
 * function invocation; ~3 s on a cold instance). With 300 s, a page visited in this tab is
 * reused for 5 minutes: no request, no invocation. Data only changes on a redeploy (build-time
 * snapshot), so the reused page is the same page; a navigation that reaches a new deployment
 * makes Next.js reload the document, which clears this cache.
 *
 * `staleTimes` is an experimental Next.js option (introduced in 14.2; its dynamic default changed
 * from 30 s to 0 in 15). scripts/navigation.e2e.ts pins the behaviour, so an upgrade that changes
 * it fails CI. Removing this line restores the previous behaviour exactly. Prefetching
 * stays off (src/components/ui/app-link.tsx): this adds no requests.
 */
export const ROUTER_CACHE_DYNAMIC_SECONDS = 300;

export default function nextConfig(phase: string): NextConfig {
  return {
    poweredByHeader: false,
    experimental: { staleTimes: { dynamic: ROUTER_CACHE_DYNAMIC_SECONDS } },
    // The rate limiter (src/proxy.ts) must see `Next-Router-Prefetch` to give router prefetches their
    // own budget. By default Next.js deletes that and the other router headers before Proxy runs, so
    // every prefetch counted as a full profile render (docs/TRAFFIC.md). The proxy reads only the
    // pathname and never rewrites or redirects, so skipping normalization changes nothing else.
    skipProxyUrlNormalize: true,
    outputFileTracingIncludes: snapshotTracing(phase),
    env: snapshotViewsEnv(phase),
    async headers() {
      // CDN caching (src/lib/cdn-cache.ts) only for snapshot builds; decided at build time.
      return [{ source: "/:path*", headers: securityHeaders }, ...cdnCacheRules(cdnCacheEnabled())];
    },
    async redirects() {
      return retired.map(([source, destination]) => ({
        source,
        destination,
        permanent: false,
      }));
    },
  };
}
