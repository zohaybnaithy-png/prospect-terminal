/**
 * Pre-merge checks for PR #15:
 *  1. /health is public (production, and staging exempts it from basic auth). Through the proxy it
 *     must say only "ready" or "unavailable": no memory, uptime, configuration reasons, header
 *     names, per-level or database state, or whether traffic protection is off. Full details only
 *     for a direct local request (the deploy health gate and the monitor on the same host).
 *  2. The monitor must alert when traffic protection is anything but "protected", including the
 *     explicit PT_RATE_LIMIT=off emergency switch, and staging must default to protected.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildHealthResponse, isLocalHealthRequest } from "../src/lib/health-response";
import { trafficHealth, trafficState } from "../src/lib/traffic/health";
import { evaluateHealth } from "./ops/monitor";

const PROD = { NODE_ENV: "production", PT_SITE_URL: "https://prospectterminal.example", PT_CLIENT_IP_HEADER: "x-pt-client-ip" };
const viaCaddy = (client = "203.0.113.9", extra: Record<string, string> = {}) =>
  new Headers({ "x-forwarded-for": client, "x-pt-client-ip": client, ...extra });
// Next.js fills X-Forwarded-For with the socket address for direct requests (traffic/health.ts).
const direct = () => new Headers({ "x-forwarded-for": "127.0.0.1" });

const ready = { status: "ready" as const, levels: { aaa: "ready" as const }, refreshFailing: ["aaa" as const] };
const starting = { status: "starting" as const, levels: { aaa: "loading" as const } };
const extras = { indexing: "off" as const, process: { uptimeSeconds: 12, rssMB: 900, heapUsedMB: 400, heapLimitMB: 1536 } };

describe("/health public exposure", () => {
  test("through the proxy: only ready/unavailable, with the right HTTP status", () => {
    const local = isLocalHealthRequest(viaCaddy(), PROD);
    assert.equal(local, false);
    const ok = buildHealthResponse(ready, { status: "protected" }, extras, local);
    assert.deepEqual([ok.status, ok.body], [200, { status: "ready" }]);
    const down = buildHealthResponse(starting, { status: "protected" }, extras, local);
    assert.deepEqual([down.status, down.body], [503, { status: "unavailable" }]);
    // Misconfigured protection: 503 for the uptime check, but no reason, header name or env name.
    const mis = buildHealthResponse(ready, { status: "misconfigured", reason: "proxied requests arrive without the x-pt-client-ip header" }, extras, local);
    assert.deepEqual([mis.status, mis.body], [503, { status: "unavailable" }]);
    // Disabled protection is not advertised to the internet.
    const off = buildHealthResponse(ready, { status: "disabled", reason: "PT_RATE_LIMIT=off" }, extras, local);
    assert.deepEqual([off.status, off.body], [200, { status: "ready" }]);
    for (const r of [ok, down, mis, off])
      assert.doesNotMatch(JSON.stringify(r.body), /rss|heap|uptime|traffic|PT_|x-pt|refresh|aaa|indexing|levels/i);
  });

  test("forged headers cannot unlock details", () => {
    // A client sending X-Forwarded-For: 127.0.0.1 still arrives with Caddy's overwritten identity header.
    assert.equal(isLocalHealthRequest(viaCaddy("203.0.113.9", { "x-forwarded-for": "127.0.0.1" }), PROD), false);
    // A Caddyfile without header_up: X-Forwarded-For names the real client.
    assert.equal(isLocalHealthRequest(new Headers({ "x-forwarded-for": "198.51.100.7" }), PROD), false);
    // Other forwarding headers mean a proxy was involved.
    assert.equal(isLocalHealthRequest(new Headers({ "x-forwarded-for": "127.0.0.1", forwarded: "for=198.51.100.7" }), PROD), false);
    assert.equal(isLocalHealthRequest(new Headers({ "x-forwarded-for": "127.0.0.1", "x-real-ip": "198.51.100.7" }), PROD), false);
    // A custom identity header name is honoured as well as the default one.
    assert.equal(isLocalHealthRequest(new Headers({ "x-forwarded-for": "127.0.0.1", "x-edge-ip": "198.51.100.7" }), { ...PROD, PT_CLIENT_IP_HEADER: "x-edge-ip" }), false);
    // Some proxy chains send a list: never treated as loopback.
    assert.equal(isLocalHealthRequest(new Headers({ "x-forwarded-for": "127.0.0.1", "x-pt-client-ip": "127.0.0.1, 203.0.113.9" }), PROD), false);
  });

  test("a direct local request (deploy gate, monitor, operator's curl) gets the full report", () => {
    assert.equal(isLocalHealthRequest(direct(), PROD), true);
    assert.equal(isLocalHealthRequest(new Headers(), PROD), true);
    const r = buildHealthResponse(ready, { status: "disabled", reason: "PT_RATE_LIMIT=off" }, extras, true);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ...ready, traffic: { status: "disabled", reason: "PT_RATE_LIMIT=off" }, ...extras });
    const mis = buildHealthResponse(ready, { status: "misconfigured", reason: "x" }, extras, true);
    assert.deepEqual([mis.status, (mis.body as { status: string }).status], [503, "misconfigured"]);
  });

  test("the route uses the request's headers and never caches", () => {
    const route = readFileSync("src/app/health/route.ts", "utf8");
    assert.match(route, /export async function GET\(request: Request\)/);
    assert.match(route, /isLocalHealthRequest\(request\.headers, process\.env\)/);
    assert.match(route, /"Cache-Control": "no-store"/);
  });
});

describe("monitor: traffic protection must be on", () => {
  const body = (traffic: unknown) => ({ status: "ready", traffic, process: { rssMB: 800 } });
  const trafficCheck = (b: unknown) => evaluateHealth(200, b, 2560).find((c) => c.name === "traffic")!;

  test("protected is ok; disabled, misconfigured, development and missing all alert", () => {
    assert.equal(trafficCheck(body({ status: "protected" })).status, "ok");
    const off = trafficCheck(body({ status: "disabled", reason: "PT_RATE_LIMIT=off" }));
    assert.equal(off.status, "alert");
    assert.match(off.detail, /traffic protection is DISABLED \(PT_RATE_LIMIT=off\)/);
    assert.match(trafficCheck(body({ status: "misconfigured", reason: "PT_CLIENT_IP_HEADER is unset" })).detail, /misconfigured \(PT_CLIENT_IP_HEADER is unset\)/);
    assert.match(trafficCheck(body({ status: "development" })).detail, /NODE_ENV/);
    // The public body has no traffic field: a monitor pointed at the public URL must not pass.
    assert.match(trafficCheck({ status: "ready" }).detail, /no traffic status/);
  });
});

describe("staging defaults to protected", () => {
  test("the documented staging env with the staging Caddyfile is 'protected'", () => {
    const doc = readFileSync("docs/STAGING-SERVER.md", "utf8");
    const block = /`\/etc\/prospect-terminal\/env` \(web\)[^\n]*\n\n```\n([\s\S]*?)```/.exec(doc)![1];
    const env: Record<string, string> = { NODE_ENV: "production" };
    for (const l of block.trim().split("\n")) {
      const [k, ...v] = l.split("=");
      env[k] = v.join("=").replace("<your-domain>", "example.com");
    }
    assert.equal(env.PT_INDEXING, "off");
    assert.equal(env.PT_RATE_LIMIT, undefined);
    assert.deepEqual(trafficHealth(env, trafficState()), { status: "protected" });
    assert.match(readFileSync("deploy/Caddyfile.staging", "utf8"), /\n\t\theader_up X-PT-Client-IP \{remote_host\}\n/);
  });

  test("no template or unit turns rate limiting off", () => {
    for (const f of readdirSync("deploy")) {
      const live = readFileSync(`deploy/${f}`, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      assert.doesNotMatch(live, /PT_RATE_LIMIT/, f);
    }
  });
});
