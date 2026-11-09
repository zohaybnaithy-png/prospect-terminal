import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The rate limiter (src/proxy.ts) must see `Next-Router-Prefetch` to give router prefetches their
  // own budget. By default Next.js deletes that and the other router headers before Proxy runs, so
  // every prefetch counted as a full profile render (docs/TRAFFIC.md). The proxy reads only the
  // pathname and never rewrites or redirects, so skipping normalization changes nothing else.
  skipProxyUrlNormalize: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return retired.map(([source, destination]) => ({
      source,
      destination,
      permanent: false,
    }));
  },
};
export default nextConfig;
