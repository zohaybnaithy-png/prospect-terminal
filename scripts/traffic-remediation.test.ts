/**
 * Pre-merge remediation of PR #12 (written to reproduce each problem before the fix):
 *  1. fail-open must be visible and must block a release (health) in production;
 *  2. the server-wide profile budget must have a hard bound however many addresses take part;
 *  3. held (delayed) refusals must be bounded per client, not only in total.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLimiter, OVERLOAD } from "../src/lib/traffic/policy";
import { trafficHealth, recordIdentity, trafficState } from "../src/lib/traffic/health";
import { readFileSync } from "node:fs";

const ENV = { PT_CLIENT_IP_HEADER: "x-pt-client-ip", PT_SITE_URL: "https://prospectterminal.example" };
const H = (ip: string | null, extra: Record<string, string> = {}) => {
  const h = new Headers(extra);
  if (ip !== null) h.set("x-pt-client-ip", ip);
  return h;
};
const PROFILE = "/players/0a3576f9-75f2-4be1-8342-a820c380ba31";

describe("1. fail-open is detected and blocks a production release", () => {
  test("production config without a trusted identity header is 'misconfigured' (health 503)", () => {
    for (const env of [{}, { PT_CLIENT_IP_HEADER: "x-forwarded-for" }, { PT_CLIENT_IP_HEADER: "bad header" }, { PT_SITE_URL: "https://p.example" }])
      assert.equal(trafficHealth({ ...env, NODE_ENV: "production" }, trafficState(), 0).status, "misconfigured", JSON.stringify(env));
    assert.equal(trafficHealth({ ...ENV, NODE_ENV: "production" }, trafficState(), 0).status, "protected");
    // An explicit opt-out is allowed, and reported as such (not an error).
    assert.equal(trafficHealth({ PT_RATE_LIMIT: "off", PT_SITE_URL: "https://p.example", NODE_ENV: "production" }, trafficState(), 0).status, "disabled");
    // Missing site URL is a release error too (canonical URLs would point at localhost).
    assert.equal(trafficHealth({ PT_CLIENT_IP_HEADER: "x-pt-client-ip", NODE_ENV: "production" }, trafficState(), 0).status, "misconfigured");
  });

  test("development never fails on traffic configuration", () => {
    assert.equal(trafficHealth({ NODE_ENV: "development" }, trafficState(), 0).status, "development");
    assert.equal(trafficHealth({}, trafficState(), 0).status, "development");
  });

  test("requests that came through a proxy without the identity header mark the server misconfigured for 10 minutes", () => {
    const s = trafficState();
    // A direct local request (no proxy headers) is fine: deploy health checks, an operator's curl.
    recordIdentity(s, new Headers(), false, 1000);
    assert.equal(trafficHealth({ ...ENV, NODE_ENV: "production" }, s, 1000).status, "protected");
    // Proxied (Caddy always sets X-Forwarded-For) but unidentified: Caddy's header_up is missing.
    recordIdentity(s, new Headers({ "x-forwarded-for": "203.0.113.9" }), false, 2000);
    const h = trafficHealth({ ...ENV, NODE_ENV: "production" }, s, 3000);
    assert.equal(h.status, "misconfigured");
    assert.match(h.reason ?? "", /without the x-pt-client-ip header/);
    assert.equal(trafficHealth({ ...ENV, NODE_ENV: "production" }, s, 2000 + 10 * 60_000 + 1).status, "protected", "clears after 10 minutes");
    // Next.js itself fills in X-Forwarded-For from the socket for direct requests (base-server.js:
    // `x-forwarded-for ??= socket.remoteAddress`), so a direct local request DOES carry it, with
    // the loopback address. That must not count as "proxied" (found in the end-to-end run).
    const d = trafficState();
    for (const local of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) recordIdentity(d, new Headers({ "x-forwarded-for": local }), false, 5);
    assert.equal(trafficHealth({ ...ENV, NODE_ENV: "production" }, d, 6).status, "protected");
    // Identified proxied requests never count.
    const t = trafficState();
    recordIdentity(t, new Headers({ "x-forwarded-for": "203.0.113.9" }), true, 1);
    assert.equal(trafficHealth({ ...ENV, NODE_ENV: "production" }, t, 2).status, "protected");
  });
});

describe("2. the server-wide budget has a hard bound", () => {
  test("1,000 addresses each under their own limit are admitted at no more than global + fair-share overflow", () => {
    let t = 0;
    const l = createLimiter({ env: ENV, now: () => t });
    let admitted = 0;
    const windowStart = 120_000;
    // 1,000 addresses, one profile each every 10 s (100/s in total) for 5 minutes.
    for (let ms = 0; ms < 300_000; ms += 100) {
      for (let k = 0; k < 10; k++) {
        const ip = `10.${(((ms / 100) * 10 + k) % 1000) >> 8}.${(((ms / 100) * 10 + k) % 1000) & 255}.1`;
        if (l.decide(PROFILE, H(ip)).action === "allow" && ms >= windowStart) admitted++;
      }
      t += 100;
    }
    const perSec = admitted / ((300_000 - windowStart) / 1000);
    const bound = OVERLOAD.global.refillPerSec + OVERLOAD.fairShareOverflow.refillPerSec;
    assert.ok(perSec <= bound + 0.5, `admitted ${perSec.toFixed(1)}/s; bound ${bound}/s`);
  });
});

describe("3. held refusals are bounded per client", () => {
  test("one client cannot occupy more than its share of the held refusals", async () => {
    const { heldPerClientLimit, holdDecision } = await import("../src/lib/traffic/hold");
    const held = new Map<string, number>();
    let total = 0;
    let holdable = 0;
    for (let i = 0; i < 5000; i++) {
      if (holdDecision(held, "4:192.0.2.66", total) !== "hold") continue;
      holdable++;
      total++;
      held.set("4:192.0.2.66", (held.get("4:192.0.2.66") ?? 0) + 1);
    }
    assert.equal(holdable, heldPerClientLimit);
    assert.equal(holdDecision(held, "4:198.51.100.1", total), "hold", "another client still gets a slot");
  });
});

describe("4. shared addresses", () => {
  test("50 people behind one NAT, each opening a profile every 10 s, are never refused a navigation", () => {
    let t = 0;
    const l = createLimiter({ env: ENV, now: () => t });
    let navRefused = 0, nav = 0;
    // 50 browsers × one profile per 10 s = 5 navigations/s from one address, for 10 minutes.
    for (let ms = 0; ms < 600_000; ms += 200) {
      nav++;
      if (l.decide(PROFILE, H("198.51.100.7")).action === "reject") navRefused++;
      if ((ms / 200) % 2 === 0 && l.decide("/players", H("198.51.100.7")).action === "reject") navRefused++;
      t += 200;
    }
    assert.equal(navRefused, 0, `${navRefused} of ${nav} navigations refused`);
  });
});

describe("5. the proxy can see that a request is a router prefetch", () => {
  test("next.config keeps router headers visible to the proxy (skipProxyUrlNormalize)", async () => {
    // By default Next.js deletes `rsc`, `next-router-prefetch` and the other flight headers from the
    // request it hands to Proxy (next/dist/server/web/adapter.js, FLIGHT_HEADERS). Every prefetch
    // was then classified as a full profile render and spent the profile budget: one visitor's
    // page views (~30 profile prefetches each) used it up (found in the end-to-end NAT run).
    const config = (await import("../next.config")).default;
    assert.equal(config.skipProxyUrlNormalize, true);
    // The proxy relies only on the pathname, which is the same with or without normalization.
    assert.doesNotMatch(readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8"), /NextResponse\.(rewrite|redirect)/);
  });
});

describe("6. one heavy client cannot monopolize the server-wide budget", () => {
  for (const scenario of [
    { name: "one crawler at its full per-address rate", crawlers: 1, perSec: 20 },
    { name: "64 crawler addresses at 0.25/s each", crawlers: 64, perSec: 16 },
  ])
    test(`${scenario.name}: readers opening a profile every 10 s are not refused after the first 15 s`, () => {
      let t = 0;
      const l = createLimiter({ env: ENV, now: () => t });
      let refusedLate = 0, readerRequests = 0, k = 0;
      // 10 readers, each a profile every 10 s (1/s in total), for 5 minutes.
      for (let ms = 0; ms < 300_000; ms += 50) {
        for (let c = 0; c < (scenario.perSec * 50) / 1000; c++) l.decide(PROFILE, H(`192.0.2.${k++ % scenario.crawlers}`));
        if (ms % 1000 === 0) {
          readerRequests++;
          const reader = `203.0.113.${(ms / 1000) % 10}`;
          if (l.decide(PROFILE, H(reader)).action === "reject" && ms >= 15_000) refusedLate++;
        }
        t += 50;
      }
      assert.equal(refusedLate, 0, `${refusedLate} of ${readerRequests} reader requests refused after 15 s`);
    });
});

describe("7. deployment safeguards in front of the app", () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  test("the app gets file-descriptor headroom for held refusals", () => {
    assert.match(read("deploy/prospect-terminal.service"), /^LimitNOFILE=16384$/m);
  });
  test("Caddy bounds slow clients and request bodies", () => {
    const c = read("deploy/Caddyfile");
    assert.match(c, /read_header 10s/);
    assert.match(c, /read_body 10s/);
    assert.match(c, /idle 2m/);
    assert.match(c, /max_size 64KB/);
  });
  test("the nftables connection limit covers IPv4 and IPv6 /64 on 80/443 and is not applied by deploy", () => {
    const n = read("deploy/nftables-conn-limit.nft");
    assert.match(n, /tcp dport \{ 80, 443 \} ct state new add @perip4 \{ ip saddr ct count over 64 \}/);
    assert.match(n, /ip6 saddr & ffff:ffff:ffff:ffff:: ct count over 64/);
    assert.doesNotMatch(read("deploy/deploy.sh"), /nft /);
  });
});
