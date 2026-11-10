import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { robotsFor } from "@/lib/crawl-policy";
import { siteOrigin } from "@/lib/site-url";

/** robots.txt, built per request so `PT_SITE_URL` comes from the server's environment (the build
 *  has none). Advisory only; see src/lib/crawl-policy.ts. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();
  return robotsFor(siteOrigin());
}
