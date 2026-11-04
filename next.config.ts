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

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    return retired.map(([source, destination]) => ({
      source,
      destination,
      permanent: false,
    }));
  },
};
export default nextConfig;
