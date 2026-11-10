/**
 * Phase 5B traffic protection: rate limiting (token buckets, client identity, classes, the proxy's
 * 429 response) and the crawl policy (robots.txt rules, sitemap, canonical URLs). No server, no
 * database. Load tests against a running build: docs/TRAFFIC.md.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { TokenBuckets } from "../src/lib/traffic/token-bucket";
import { clientKey, identityConfig, ipv6Prefix64 } from "../src/lib/traffic/client-identity";
import { LIMITS, OVERLOAD, classify, createLimiter, tooManyRequests, type TrafficClass } from "../src/lib/traffic/policy";

/** Per-client tests isolate the per-client budgets from the server-wide overload budget. */
const NO_OVERLOAD = { global: { capacity: 1e9, refillPerSec: 1e9, maxKeys: 1 }, fairShare: OVERLOAD.fairShare, fairShareOverflow: OVERLOAD.fairShareOverflow };
import { DISALLOW, isCrawlAllowed, robotsPolicy, STATIC_PAGES } from "../src/lib/crawl-policy";
import { siteOrigin } from "../src/lib/site-url";
import { sitemapEntries } from "../src/lib/sitemap";
import type { LevelSnapshot } from "../src/services/competition/types";

const ROOT = new URL("..", import.meta.url).pathname;
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ENV = { PT_CLIENT_IP_HEADER: "x-pt-client-ip" };
const H = (ip: string | null, extra: Record<string, string> = {}) => {
  const h = new Headers(extra);
  if (ip !== null) h.set("x-pt-client-ip", ip);
  return h;
};
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const PROFILE = "/players/0a3576f9-75f2-4be1-8342-a820c380ba31";

describe("token buckets", () => {
  test("allow `capacity` requests at once, then refuse with Retry-After until a token refills", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 5, refillPerSec: 1, maxKeys: 100 }, c.now);
    for (let i = 0; i < 5; i++) assert.equal(b.take("a").ok, true, `request ${i + 1}`);
    const refused = b.take("a");
    assert.deepEqual(refused, { ok: false, remaining: 0, retryAfterSec: 1 });
    c.advance(999);
    assert.equal(b.take("a").ok, false, "not before the token is back");
    c.advance(1);
    assert.equal(b.take("a").ok, true, "exactly when Retry-After said");
  });

  test("Retry-After is the real wait, rounded up, at any refill rate", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 1, refillPerSec: 0.25, maxKeys: 10 }, c.now);
    b.take("a");
    assert.equal(b.take("a").retryAfterSec, 4);
    c.advance(1500);
    assert.equal(b.take("a").retryAfterSec, 3, "2.5 s left → 3");
    c.advance(2500);
    assert.equal(b.take("a").ok, true);
  });

  test("limits reset: an idle client is back to a full burst, never more", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 10, refillPerSec: 2, maxKeys: 10 }, c.now);
    for (let i = 0; i < 10; i++) b.take("a");
    assert.equal(b.take("a").ok, false);
    c.advance(60_000); // far longer than needed to refill
    let ok = 0;
    while (b.take("a").ok) ok++;
    assert.equal(ok, 10, "refills to capacity, not 120 tokens");
  });

  test("refused requests do not extend the wait (no penalty spiral for a retrying client)", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 1, refillPerSec: 1, maxKeys: 10 }, c.now);
    b.take("a");
    for (let i = 0; i < 50; i++) {
      c.advance(10);
      b.take("a");
    }
    c.advance(500); // 1 s since the last successful request
    assert.equal(b.take("a").ok, true);
  });

  test("clients are independent", () => {
    const b = new TokenBuckets({ capacity: 1, refillPerSec: 1, maxKeys: 10 }, clock().now);
    assert.equal(b.take("a").ok, true);
    assert.equal(b.take("a").ok, false);
    assert.equal(b.take("b").ok, true, "another client is unaffected");
  });

  test("a clock stepping backwards neither adds nor removes tokens", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 2, refillPerSec: 1, maxKeys: 10 }, c.now);
    b.take("a");
    b.take("a");
    c.advance(-3_600_000);
    assert.equal(b.take("a").ok, false);
  });

  test("memory is bounded; eviction is O(1) and only ever forgives (LRU)", () => {
    const c = clock();
    const b = new TokenBuckets({ capacity: 1, refillPerSec: 0.001, maxKeys: 1000 }, c.now);
    b.take("victim");
    assert.equal(b.take("victim").ok, false);
    const start = performance.now();
    for (let i = 0; i < 200_000; i++) b.take(`k${i}`);
    const ms = performance.now() - start;
    assert.equal(b.size, 1000);
    assert.ok(ms < 2000, `200k distinct keys took ${ms.toFixed(0)} ms (must stay linear)`);
    // The evicted client starts again with a full bucket: forgiven, never locked out.
    assert.equal(b.take("victim").ok, true);
  });

  test("rejects nonsensical configuration", () => {
    assert.throws(() => new TokenBuckets({ capacity: 0, refillPerSec: 1, maxKeys: 1 }));
    assert.throws(() => new TokenBuckets({ capacity: 1, refillPerSec: 0, maxKeys: 1 }));
  });
});

describe("client identity (never from spoofable headers)", () => {
  test("only the configured header is read; unset means no identity", () => {
    assert.deepEqual(identityConfig({}), { header: null, reason: "unset" });
    assert.deepEqual(identityConfig({ PT_CLIENT_IP_HEADER: " X-PT-Client-IP " }), { header: "x-pt-client-ip" });
    assert.equal(clientKey(H("203.0.113.9"), identityConfig({})), null);
  });

  test("client-controlled headers are refused as the identity source, even if configured", () => {
    for (const name of ["X-Forwarded-For", "x-real-ip", "Forwarded", "CF-Connecting-IP", "True-Client-IP"])
      assert.deepEqual(identityConfig({ PT_CLIENT_IP_HEADER: name }), { header: null, reason: "refused" }, name);
    assert.deepEqual(identityConfig({ PT_CLIENT_IP_HEADER: "x bad" }), { header: null, reason: "invalid" });
  });

  test("X-Forwarded-For, X-Real-IP and Forwarded never change the key", () => {
    const config = identityConfig(ENV);
    const key = clientKey(H("203.0.113.9"), config);
    for (let i = 0; i < 50; i++) {
      const spoofed = H("203.0.113.9", {
        "x-forwarded-for": `198.51.100.${i}, 10.0.0.${i}`,
        "x-real-ip": `198.51.100.${i}`,
        forwarded: `for=198.51.100.${i}`,
      });
      assert.equal(clientKey(spoofed, config), key);
    }
    assert.equal(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1" }), config), null, "XFF alone is no identity");
  });

  test("the value must be exactly one IP literal", () => {
    const config = identityConfig(ENV);
    assert.equal(clientKey(H("203.0.113.9"), config), "4:203.0.113.9");
    for (const bad of ["203.0.113.9, 198.51.100.1", "203.0.113.9:443", "example.com", "", "unknown", "999.1.1.1", "[2001:db8::1]"])
      assert.equal(clientKey(H(bad), config), null, JSON.stringify(bad));
    // Two header lines are joined with ", " by Headers: also refused.
    const two = new Headers();
    two.append("x-pt-client-ip", "203.0.113.9");
    two.append("x-pt-client-ip", "198.51.100.1");
    assert.equal(clientKey(two, config), null);
  });

  test("IPv6 is keyed per /64 (one subscriber cannot rotate addresses); mapped IPv4 is IPv4", () => {
    const config = identityConfig(ENV);
    const a = clientKey(H("2001:db8:1:2:aaaa::1"), config);
    assert.equal(a, "6:2001:db8:1:2");
    assert.equal(clientKey(H("2001:db8:1:2:ffff:ffff:ffff:ffff"), config), a);
    assert.equal(clientKey(H("2001:0db8:0001:0002::7"), config), a, "leading zeros normalized");
    assert.notEqual(clientKey(H("2001:db8:1:3::1"), config), a, "another /64 is another client");
    assert.equal(clientKey(H("::ffff:203.0.113.9"), config), "4:203.0.113.9");
    assert.equal(ipv6Prefix64("::1"), "0:0:0:0");
    assert.equal(ipv6Prefix64("fe80::1%eth0"), "fe80:0:0:0");
    assert.equal(ipv6Prefix64("2001:db8::"), "2001:db8:0:0");
  });
});

describe("request classes and budgets", () => {
  test("classification", () => {
    const none = new Headers();
    assert.equal(classify(PROFILE, none), "profile");
    assert.equal(classify(`${PROFILE}/`, none), "profile");
    assert.equal(classify("/players", none), "page");
    assert.equal(classify("/trends/data", none), "page");
    assert.equal(classify("/_next/image", none), "page");
    assert.equal(classify(PROFILE, new Headers({ "next-router-prefetch": "1" })), "prefetch");
    for (const exempt of ["/health", "/robots.txt", "/sitemap.xml", "/icon.png", "/_next/static/chunks/a.js"])
      assert.equal(classify(exempt, none), null, exempt);
  });

  test("a heavy reader (many page views with all their prefetches) is never limited", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now });
    let refused = 0;
    // 60 page views over 10 minutes: one profile navigation every 10 s, each followed by the
    // 65 prefetches a page view issues (measured), plus a directory page every third view.
    for (let v = 0; v < 60; v++) {
      if (l.decide(PROFILE, H("203.0.113.9")).action === "reject") refused++;
      if (v % 3 === 0 && l.decide("/players", H("203.0.113.9")).action === "reject") refused++;
      for (let p = 0; p < 65; p++)
        if (l.decide(PROFILE, H("203.0.113.9", { "next-router-prefetch": "1" })).action === "reject") refused++;
      c.advance(10_000);
    }
    assert.equal(refused, 0);
  });

  test("20 people behind one shared address (NAT) browsing normally are never limited", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now });
    let refused = 0;
    // Each person opens a profile every 30 s with its prefetches; requests interleave over 10 min.
    for (let s = 0; s < 600; s += 1.5) {
      // 20 people / 30 s = one profile view every 1.5 s from the shared address.
      if (l.decide(PROFILE, H("198.51.100.7")).action === "reject") refused++;
      for (let p = 0; p < 20; p++)
        if (l.decide(PROFILE, H("198.51.100.7", { "next-router-prefetch": "1" })).action === "reject") refused++;
      c.advance(1500);
    }
    assert.equal(refused, 0);
  });

  test("a crawler fetching 20 profiles/s gets the burst, then its per-address rate; others are unaffected", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now, overload: NO_OVERLOAD });
    let allowed = 0, refused = 0;
    for (let i = 0; i < 20 * 60; i++) {
      const d = l.decide(PROFILE, H("192.0.2.66"));
      if (d.action === "allow") allowed++;
      else {
        refused++;
        assert.ok(d.result.retryAfterSec >= 1);
      }
      c.advance(50);
    }
    // Burst + refill for 60 s (per-client limits only here; overload shedding is tested separately).
    const expected = LIMITS.profile.capacity + 60 * LIMITS.profile.refillPerSec;
    assert.ok(Math.abs(allowed - expected) <= 5, `allowed ${allowed}, expected ~${expected}`);
    assert.equal(allowed + refused, 1200);
    assert.equal(l.decide(PROFILE, H("203.0.113.9")).action, "allow", "another client still served");
    assert.equal(l.decide("/players", H("192.0.2.66")).action, "allow", "the crawler's page budget is separate");
  });

  test("a polite search-engine crawler (one profile every 2 s per address) is never limited", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now });
    for (let i = 0; i < 1800; i++) {
      assert.equal(l.decide(PROFILE, H("66.249.66.1", { "user-agent": "Googlebot/2.1" })).action, "allow");
      c.advance(2000);
    }
  });

  test("forged prefetch headers only reach the separately capped prefetch budget", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now, overload: NO_OVERLOAD });
    const forged = H("192.0.2.66", { "next-router-prefetch": "1" });
    let allowed = 0;
    for (let i = 0; i < 2000; i++) if (l.decide(PROFILE, forged).action === "allow") allowed++;
    assert.equal(allowed, LIMITS.prefetch.capacity);
    // Its profile budget is untouched: the forged requests spent nothing there (and the server
    // answers a prefetch with the cheap shell, never a full profile).
    for (let i = 0; i < LIMITS.profile.capacity; i++) assert.equal(l.decide(PROFILE, H("192.0.2.66")).action, "allow");
  });

  test("spoofed forwarding headers cannot bypass the limit", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now, overload: NO_OVERLOAD });
    let allowed = 0;
    for (let i = 0; i < 500; i++) {
      const h = H("192.0.2.66", { "x-forwarded-for": `10.${i >> 8}.${i & 255}.1`, "x-real-ip": `10.9.${i & 255}.1` });
      if (l.decide(PROFILE, h).action === "allow") allowed++;
    }
    assert.equal(allowed, LIMITS.profile.capacity, "one client, one bucket, whatever XFF says");
  });

  test("no trustworthy identity fails open (never one shared bucket); the switch disables limiting", () => {
    const unset = createLimiter({ env: {} });
    for (let i = 0; i < 1000; i++) assert.equal(unset.decide(PROFILE, H("192.0.2.66")).action, "allow");
    const missing = createLimiter({ env: ENV });
    const d = missing.decide(PROFILE, new Headers({ "x-forwarded-for": "192.0.2.66" }));
    assert.deepEqual(d, { action: "allow", reason: "no-identity", cls: "profile" });
    const off = createLimiter({ env: { ...ENV, PT_RATE_LIMIT: "off" } });
    for (let i = 0; i < 1000; i++) assert.equal(off.decide(PROFILE, H("192.0.2.66")).action, "allow");
  });

  test("overload: many addresses each under their own limit are shed once the server budget is spent", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now });
    // 64 crawler addresses, 0.25 profiles/s each (16/s total, measured server capacity), for 3 min,
    // plus 10 readers who open a profile every 30 s.
    let crawlerServed = 0, readerRefused = 0, readerServed = 0;
    const lastHalf: number[] = [];
    for (let ms = 0; ms < 180_000; ms += 250) {
      // 4 crawler requests every 250 ms = 16/s, rotating over 64 addresses.
      for (let k = 0; k < 4; k++) {
        const ip = `192.0.2.${((ms / 250) * 4 + k) % 64}`;
        const d = l.decide(PROFILE, H(ip));
        if (d.action === "allow") {
          crawlerServed++;
          if (ms >= 120_000) lastHalf.push(1);
        } else {
          assert.equal(d.reason, "overload");
          assert.ok(d.result.retryAfterSec >= 1);
        }
      }
      if (ms % 3000 === 0) {
        const reader = `203.0.113.${(ms / 3000) % 10}`;
        if (l.decide(PROFILE, H(reader)).action === "allow") readerServed++;
        else {
          readerRefused++;
          // At the very start every crawler address still looks like a reader (full fair share)
          // and competes for the capped overflow; within seconds they fall below the reserve.
          assert.ok(ms < 10_000, `reader refused at ${ms / 1000} s`);
        }
      }
      c.advance(250);
    }
    assert.ok(readerRefused <= 3, `${readerRefused} reader refusals (only in the first seconds)`);
    assert.equal(readerServed + readerRefused, 60);
    // Once the crawlers' fair shares are spent, admitted renders stay within the server budget plus
    // the capped fair-share overflow (6 + 4/s), whatever the number of addresses.
    const perSecLate = lastHalf.length / 60;
    const bound = OVERLOAD.global.refillPerSec + OVERLOAD.fairShareOverflow.refillPerSec;
    assert.ok(perSecLate <= bound + 0.3, `crawlers served ${perSecLate.toFixed(1)}/s at the end (bound ${bound.toFixed(1)})`);
    assert.ok(crawlerServed < 16 * 180, "some crawler requests were shed");
  });

  test("overload shedding never applies to other pages or prefetches", () => {
    const c = clock();
    const l = createLimiter({ env: ENV, now: c.now, overload: { global: { capacity: 1, refillPerSec: 0.001, maxKeys: 1 }, fairShare: { capacity: 1, refillPerSec: 0.001, maxKeys: 10 }, fairShareOverflow: OVERLOAD.fairShareOverflow } });
    l.decide(PROFILE, H("192.0.2.1"));
    assert.equal(l.decide(PROFILE, H("192.0.2.1")).action, "reject");
    for (let i = 0; i < 50; i++) {
      assert.equal(l.decide("/players", H("192.0.2.1")).action, "allow");
      assert.equal(l.decide(PROFILE, H("192.0.2.1", { "next-router-prefetch": "1" })).action, "allow");
    }
    assert.equal(l.decide(PROFILE, H("192.0.2.2")).action, "allow", "a new client still has its fair share");
  });

  test("PT_PROFILE_BUDGET_RPS tunes the server-wide budget within 1–100, otherwise the default", async () => {
    const { overloadFromEnv } = await import("../src/lib/traffic/policy");
    assert.deepEqual(overloadFromEnv({ PT_PROFILE_BUDGET_RPS: "15" }).global, { capacity: 30, refillPerSec: 15, maxKeys: 1 });
    for (const bad of [undefined, "", "0", "-3", "abc", "1000"]) assert.deepEqual(overloadFromEnv({ PT_PROFILE_BUDGET_RPS: bad }), OVERLOAD, String(bad));
  });

  test("the health check is never limited", () => {
    const l = createLimiter({ env: ENV, now: clock().now });
    for (let i = 0; i < 10_000; i++) assert.deepEqual(l.decide("/health", H("127.0.0.1")), { action: "allow", reason: "exempt" });
  });

  test("stats count refusals per class and reset after each read", () => {
    const l = createLimiter({ env: ENV, now: clock().now, limits: { profile: { capacity: 1, refillPerSec: 1, maxKeys: 10 }, page: LIMITS.page, prefetch: LIMITS.prefetch } });
    l.decide(PROFILE, H("192.0.2.1"));
    l.decide(PROFILE, H("192.0.2.1"));
    l.decide(PROFILE, H("192.0.2.1"));
    assert.deepEqual(l.stats().rejected, { profile: 2, page: 0, prefetch: 0 } satisfies Record<TrafficClass, number>);
    assert.deepEqual(l.stats().rejected, { profile: 0, page: 0, prefetch: 0 });
  });
});

describe("HTTP behaviour of the proxy", () => {
  test("429 with Retry-After, no-store and a tiny body", async () => {
    const r = tooManyRequests({ ok: false, remaining: 0, retryAfterSec: 7 });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "7");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-robots-tag"), "noindex");
    assert.match(await r.text(), /^Too many requests/);
  });

  test("the real proxy(): allows within budget, then 429 + Retry-After, and recovers", async (t) => {
    const prev = { ...process.env };
    process.env.PT_CLIENT_IP_HEADER = "x-pt-client-ip";
    process.env.PT_PROFILE_BUDGET_RPS = "100";
    delete process.env.PT_RATE_LIMIT;
    const key = Symbol.for("prospect-terminal.rate-limiter");
    const g = globalThis as Record<symbol, unknown>;
    delete g[key];
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    t.after(() => {
      Date.now = realNow;
      delete g[key];
      process.env = prev;
    });
    const { proxy } = await import("../src/proxy");
    const req = (path: string, ip: string, extra: Record<string, string> = {}) =>
      new NextRequest(`http://localhost:3000${path}`, { headers: { "x-pt-client-ip": ip, ...extra } });
    // One client, 10 profiles/s (above its per-address refill), with a different forged
    // X-Forwarded-For on every request. A large server-wide budget isolates the per-client limit.
    let served = 0, refused: Response | undefined;
    for (let i = 0; i < 400 && !refused; i++) {
      const r = await proxy(req(PROFILE, "192.0.2.10", { "x-forwarded-for": `10.0.${i >> 8}.${i & 255}` }));
      if (r.status === 429) refused = r;
      else {
        served++;
        assert.equal(r.headers.get("x-middleware-next"), "1", "passed through to the app");
        now += 100;
      }
    }
    // Burst plus refill while it ran; refused well before 400 requests.
    assert.ok(served >= LIMITS.profile.capacity && served < 400, `served ${served}`);
    assert.equal(refused!.status, 429);
    assert.equal(refused!.headers.get("retry-after"), "1");
    assert.notEqual((await proxy(req(PROFILE, "192.0.2.11"))).status, 429, "another client is served");
    assert.notEqual((await proxy(req("/health", "192.0.2.10"))).status, 429, "health is exempt");
    now += 1000;
    assert.notEqual((await proxy(req(PROFILE, "192.0.2.10"))).status, 429, "served again after Retry-After");
    // The refill is exactly LIMITS.profile.refillPerSec per second, no more.
    let again = 1;
    while ((await proxy(req(PROFILE, "192.0.2.10"))).status !== 429) again++;
    assert.ok(again >= LIMITS.profile.refillPerSec && again <= LIMITS.profile.refillPerSec + 1, `served ${again} after 1 s`);
  });

  test("refusals are held for REFUSAL_DELAY_MS, at most 32 per client and 256 in total", async (t) => {
    const prev = { ...process.env };
    process.env.PT_CLIENT_IP_HEADER = "x-pt-client-ip";
    const key = Symbol.for("prospect-terminal.rate-limiter");
    const g = globalThis as Record<symbol, unknown>;
    delete g[key];
    t.after(() => {
      delete g[key];
      process.env = prev;
    });
    const { proxy, REFUSAL_DELAY_MS, heldRefusals } = await import("../src/proxy");
    const { HOLD_TOTAL_LIMIT, heldPerClientLimit } = await import("../src/lib/traffic/hold");
    const req = (ip: string) => new NextRequest(`http://localhost:3000/players`, { headers: { "x-pt-client-ip": ip } });
    const exhaust = async (ip: string) => {
      for (let i = 0; i < LIMITS.page.capacity; i++) await proxy(req(ip));
    };
    await exhaust("192.0.2.77");
    const start = performance.now();
    const one = await proxy(req("192.0.2.77"));
    assert.equal(one.status, 429);
    assert.ok(performance.now() - start >= REFUSAL_DELAY_MS - 20, "held before answering");
    // One client: only heldPerClientLimit refusals are held; the rest are answered at once.
    const burst = Array.from({ length: 50 }, () => proxy(req("192.0.2.77")));
    assert.equal(heldRefusals().total, heldPerClientLimit);
    const s2 = performance.now();
    assert.equal((await proxy(req("192.0.2.77"))).status, 429);
    assert.ok(performance.now() - s2 < 200, "beyond the per-client bound, immediate");
    await Promise.all(burst);
    // Many clients: at most HOLD_TOTAL_LIMIT held in total.
    const ips = Array.from({ length: 40 }, (_, i) => `198.51.100.${i}`);
    for (const ip of ips) await exhaust(ip);
    const many = ips.flatMap((ip) => Array.from({ length: heldPerClientLimit }, () => proxy(req(ip))));
    assert.equal(heldRefusals().total, Math.min(HOLD_TOTAL_LIMIT, ips.length * heldPerClientLimit));
    // Clients regain page tokens during the 1 s hold, so a few of these are served: never an error.
    const results = await Promise.all(many);
    assert.ok(results.every((r) => r.status === 429 || r.status === 200), "only refusals or pass-through");
    assert.ok(results.filter((r) => r.status === 429).length >= results.length * 0.7);
    assert.equal(heldRefusals().total, 0);
  });

  test("the proxy cannot touch data: it imports neither the database nor the data services", () => {
    const deps = [src("src/proxy.ts"), src("src/lib/traffic/policy.ts"), src("src/lib/traffic/token-bucket.ts"), src("src/lib/traffic/client-identity.ts")].join("\n");
    assert.doesNotMatch(deps, /@\/db|@\/services|drizzle|from "pg"/);
    assert.doesNotMatch(src("src/proxy.ts"), /x-forwarded-for|x-real-ip/i);
  });

  test("Caddy overwrites the identity header the app trusts, and env.example names the same header", () => {
    const caddy = src("deploy/Caddyfile");
    // {remote_host} is the TCP peer on every Caddy 2 release. {client_ip} is unknown before 2.7 and
    // is then forwarded LITERALLY (verified against Caddy 2.6.2), which would turn limiting off.
    const code = caddy.replace(/#.*$/gm, "");
    assert.match(code, /header_up X-PT-Client-IP \{remote_host\}/);
    assert.doesNotMatch(code, /\{client_ip\}|trusted_proxies/);
    assert.match(src("deploy/env.example"), /^PT_CLIENT_IP_HEADER=x-pt-client-ip$/m);
    assert.match(src("deploy/env.example"), /^PT_SITE_URL=https:\/\/prospectterminal\.example$/m);
    assert.match(src("deploy/prospect-terminal.service"), /--hostname 127\.0\.0\.1/, "only Caddy can reach the app");
  });
});

describe("crawl policy", () => {
  const id = "0a3576f9-75f2-4be1-8342-a820c380ba31";
  test("public pages, profiles and the assets crawlers need are allowed", () => {
    for (const url of ["/", "/players", "/trends", "/data", `/players/${id}`, "/_next/static/chunks/app.js", "/_next/image?url=%2Flogo.png&w=96&q=75", "/robots.txt", "/sitemap.xml"])
      assert.equal(isCrawlAllowed(url), true, url);
  });

  test("query combinations, internal endpoints and development pages are disallowed", () => {
    for (const url of ["/players?page=2", "/players?level=aaa&role=pitchers&sort=ops", `/players/${id}?level=aa`, "/trends?level=aaa", "/?level=high-a", "/trends/data?view=map&level=aa&role=hitter&window=14d", "/health", "/analytics/models", "/players?q=smith"])
      assert.equal(isCrawlAllowed(url), false, url);
  });

  test("robots.txt object: one rule set for every crawler, sitemap only with a valid origin", () => {
    assert.deepEqual(robotsPolicy("https://prospectterminal.example"), {
      rules: [{ userAgent: "*", allow: ["/", "/_next/"], disallow: DISALLOW }],
      sitemap: "https://prospectterminal.example/sitemap.xml",
    });
    assert.equal("sitemap" in robotsPolicy(null), false);
    assert.match(src("src/app/robots.ts"), /robotsFor\(siteOrigin\(\)\)/); // robotsPolicy unless PT_INDEXING=off
    assert.match(src("src/app/robots.ts"), /await connection\(\)/, "built at request time (PT_SITE_URL is a runtime setting)");
  });

  test("the site origin comes only from PT_SITE_URL and must be a bare http(s) origin", () => {
    assert.equal(siteOrigin({ PT_SITE_URL: "https://prospectterminal.example" }), "https://prospectterminal.example");
    assert.equal(siteOrigin({ PT_SITE_URL: "https://prospectterminal.example/" }), "https://prospectterminal.example");
    for (const bad of [undefined, "", "prospectterminal.example", "ftp://x.example", "https://x.example/sub", "https://u:p@x.example", "https://x.example/?a=1", "javascript:alert(1)"])
      assert.equal(siteOrigin({ PT_SITE_URL: bad }), null, String(bad));
    assert.doesNotMatch(src("src/lib/site-url.ts"), /from "next\/headers"|headers\(\)/, "never reads request headers");
  });

  test("sitemap: static pages plus each player with game lines once, at the canonical URL", () => {
    const lvl = (level: string, at: string | null, bat: string[], pit: string[]) =>
      ({ level, snapshot: { lastIngestedAt: at, batting: bat.map((playerId) => ({ playerId })), pitching: pit.map((playerId) => ({ playerId })) } }) as unknown as LevelSnapshot;
    const entries = sitemapEntries("https://p.example", STATIC_PAGES, [
      lvl("aa", "2026-06-01T00:00:00Z", ["p1", "p2", "p1"], ["p3"]),
      lvl("aaa", "2026-06-10T00:00:00Z", ["p1"], []),
      lvl("afl", null, [], ["p4"]),
    ]);
    assert.deepEqual(entries.map((e) => e.url), [
      "https://p.example",
      "https://p.example/players",
      "https://p.example/trends",
      "https://p.example/data",
      "https://p.example/players/p1",
      "https://p.example/players/p2",
      "https://p.example/players/p3",
      "https://p.example/players/p4",
    ]);
    assert.equal(entries.find((e) => e.url.endsWith("/p1"))?.lastModified, "2026-06-10T00:00:00Z", "latest level wins");
    assert.equal("lastModified" in entries.find((e) => e.url.endsWith("/p4"))!, false);
    assert.ok(entries.every((e) => !e.url.includes("?")), "no query strings");
    for (const e of entries) assert.equal(isCrawlAllowed(new URL(e.url).pathname), true, `${e.url} is crawlable`);
  });

  test("every public page declares its query-free canonical URL", () => {
    assert.match(src("src/app/page.tsx"), /alternates: \{ canonical: "\/" \}/);
    assert.match(src("src/app/players/page.tsx"), /alternates: \{ canonical: "\/players" \}/);
    assert.match(src("src/app/trends/page.tsx"), /alternates: \{ canonical: "\/trends" \}/);
    assert.match(src("src/app/data/page.tsx"), /alternates: \{ canonical: "\/data" \}/);
    assert.match(src("src/app/players/[id]/page.tsx"), /alternates: \{ canonical: `\/players\/\$\{id\}` \}/);
    assert.match(src("src/app/layout.tsx"), /metadataBase: metadataBase\(\)/);
  });
});
