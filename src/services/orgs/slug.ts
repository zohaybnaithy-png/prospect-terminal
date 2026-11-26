/** Organization URL helpers (client-safe: no data access). */

/** URL slug from the organization's abbreviation ("NYY" → "nyy"). */
export const orgSlug = (org: { abbreviation: string }) =>
  org.abbreviation
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Organization page link: the abbreviation slug, or the internal UUID when the slug is empty. */
export const orgHref = (org: { id: string; abbreviation: string }) => `/orgs/${orgSlug(org) || org.id}`;
