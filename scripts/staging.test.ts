/**
 * Phase 6A staging safety: a staging site must never be indexed (PT_INDEXING=off), and production
 * behaviour is unchanged when the variable is unset.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

describe("PT_INDEXING=off (staging)", () => {
  test("indexing is on only when PT_INDEXING is unset or 'on'; anything else is off (fails safe)", async () => {
    const { indexingEnabled } = await import("../src/lib/indexing");
    assert.equal(indexingEnabled({}), true);
    assert.equal(indexingEnabled({ PT_INDEXING: "on" }), true);
    for (const v of ["off", "OFF", "no", "false", "0", " off "]) assert.equal(indexingEnabled({ PT_INDEXING: v }), false, v);
  });

  test("robots.txt disallows everything and names no sitemap; production policy unchanged", async () => {
    const { robotsFor } = await import("../src/lib/crawl-policy");
    assert.deepEqual(robotsFor("https://staging.example", { PT_INDEXING: "off" }), { rules: [{ userAgent: "*", disallow: "/" }] });
    const prod = robotsFor("https://prospectterminal.example", {});
    assert.equal(prod.sitemap, "https://prospectterminal.example/sitemap.xml");
    assert.ok(JSON.stringify(prod.rules).includes("/*?"));
    assert.match(readFileSync(new URL("../src/app/robots.ts", import.meta.url), "utf8"), /robotsFor\(siteOrigin\(\)\)/);
    assert.match(readFileSync(new URL("../src/app/sitemap.ts", import.meta.url), "utf8"), /indexingEnabled\(\)/);
    assert.match(readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8"), /robots: \{ index: false, follow: false \}/);
  });

  test("every response from the proxy carries X-Robots-Tag: noindex, nofollow (also refusals and exempt paths)", async (t) => {
    const prev = { ...process.env };
    process.env.PT_INDEXING = "off";
    process.env.PT_CLIENT_IP_HEADER = "x-pt-client-ip";
    const key = Symbol.for("prospect-terminal.rate-limiter");
    const g = globalThis as Record<symbol, unknown>;
    delete g[key];
    t.after(() => {
      delete g[key];
      process.env = prev;
    });
    const { proxy } = await import("../src/proxy");
    for (const path of ["/", "/players/0a3576f9-75f2-4be1-8342-a820c380ba31", "/health", "/robots.txt"]) {
      const r = await proxy(new NextRequest(`http://localhost:3000${path}`, { headers: { "x-pt-client-ip": "192.0.2.1" } }));
      assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", path);
    }
    process.env.PT_INDEXING = "on";
    const on = await proxy(new NextRequest("http://localhost:3000/", { headers: { "x-pt-client-ip": "192.0.2.2" } }));
    assert.equal(on.headers.get("x-robots-tag"), null, "production: no header");
  });
});
