import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { getCompetitionData } from "@/services/competition";
import { STATIC_PAGES } from "@/lib/crawl-policy";
import { siteOrigin } from "@/lib/site-url";
import { sitemapEntries } from "@/lib/sitemap";

/**
 * sitemap.xml: the public pages plus one canonical URL per player with game lines at any level.
 * Built from the in-memory level cache (no database query per request). Without `PT_SITE_URL` there
 * is no trustworthy absolute origin, so only an empty sitemap is served.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const origin = siteOrigin();
  if (!origin) return [];
  const data = await getCompetitionData();
  return sitemapEntries(origin, STATIC_PAGES, data.status === "ok" ? data.levels : []);
}
