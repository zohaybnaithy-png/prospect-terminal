/**
 * Controlled load test for the traffic protection (docs/TRAFFIC.md). LOCAL ONLY: refuses any target
 * that is not a loopback address, so it can never be pointed at production or a third party.
 *
 * Setup: a production build with a disposable database, behind the repo's Caddyfile with only the
 * site address changed (e.g. `:8088`), so Caddy sets X-PT-Client-IP from the real TCP peer:
 *   DATABASE_URL=<disposable db> PT_CLIENT_IP_HEADER=x-pt-client-ip NODE_ENV=production \
 *     node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3000
 *   sed -e 's#^prospectterminal.example {#:8088 {#' -e '/^www\./,$d' deploy/Caddyfile > /tmp/Caddyfile
 *   caddy start --config /tmp/Caddyfile --adapter caddyfile
 *
 *   npm run -s traffic:load -- single 150        # 1 address, 16 connections
 *   npm run -s traffic:load -- distributed 150   # 64 addresses, 1 connection each
 *   npm run -s traffic:load -- none 60           # readers only (baseline)
 *
 * Distinct clients are distinct source addresses (127.0.x.y; Linux routes all of 127/8 to
 * loopback), so Caddy sees them as different peers, exactly as with real clients. Ten readers
 * each open a profile every 10 s; latency and refusals are reported for them and the attackers.
 * Output: one JSON line on stdout.
 */
import http from "node:http";

const PROXY_PORT = Number(process.env.PT_LOAD_PORT ?? 8088);
const APP_PORT = Number(process.env.PT_LOAD_APP_PORT ?? 3000);
const HOST = process.env.PT_LOAD_HOST ?? "127.0.0.1";
if (!/^127\.\d+\.\d+\.\d+$/.test(HOST)) throw new Error("traffic-load only targets loopback addresses");

const agents = new Map<string, http.Agent>();
interface Result {
  status: number;
  ms: number;
  at: number;
  body: string;
}
function get(path: string, from: string, port = PROXY_PORT, headers: Record<string, string> = {}): Promise<Result> {
  let agent = agents.get(from);
  if (!agent) agents.set(from, (agent = new http.Agent({ keepAlive: true, maxSockets: 64, localAddress: from })));
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const req = http.request({ host: HOST, port, path, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t, at: performance.now(), body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function profileIds(): Promise<string[]> {
  // Straight to the app (not through Caddy) with a dedicated identity, so discovery does not
  // spend any test client's budget.
  const ids = new Set<string>();
  for (let page = 1; page <= 12; page++)
    for (const role of ["", "&role=pitchers"]) {
      const r = await get(`/players?size=100&page=${page}${role}`, "127.0.0.250", APP_PORT, { "x-pt-client-ip": `10.250.0.${page}` });
      for (const m of r.body.matchAll(/\/players\/([0-9a-f-]{36})/g)) ids.add(m[1]);
    }
  if (!ids.size) throw new Error("no player profiles found; is the app running with data?");
  return [...ids];
}

async function main() {
  const [mode = "single", secsArg = "60"] = process.argv.slice(2);
  const secs = Number(secsArg);
  const ids = await profileIds();
  let idx = Math.floor(Math.random() * ids.length);
  const next = () => ids[idx++ % ids.length];
  const t0 = performance.now(), until = t0 + secs * 1000;
  const attack: Result[] = [], readers: Result[] = [];
  const crawler = async (from: string) => {
    while (performance.now() < until) attack.push(await get(`/players/${next()}`, from));
  };
  const reader = async (from: string) => {
    await sleep(Math.random() * 10_000);
    while (performance.now() < until) {
      readers.push(await get(`/players/${next()}`, from));
      await sleep(10_000);
    }
  };
  const workers: Promise<void>[] = [];
  if (mode === "single") for (let i = 0; i < 16; i++) workers.push(crawler("127.0.0.31"));
  else if (mode === "distributed") for (let i = 0; i < 64; i++) workers.push(crawler(`127.0.2.${i + 1}`));
  else if (mode !== "none") throw new Error("mode: single | distributed | none");
  for (let i = 0; i < 10; i++) workers.push(reader(`127.0.3.${i + 1}`));
  await Promise.all(workers);
  const last = (a: Result[]) => a.filter((r) => r.at - t0 >= (secs - Math.min(60, secs)) * 1000);
  const summary = (a: Result[], span: number) => {
    const ok = a.filter((r) => r.status === 200);
    return { requests: a.length, served: ok.length, servedPerSec: +(ok.length / span).toFixed(1), refused429: a.filter((r) => r.status === 429).length, p50: pct(ok.map((r) => r.ms), 0.5), p95: pct(ok.map((r) => r.ms), 0.95) };
  };
  console.log(JSON.stringify({ mode, secs, attack: summary(attack, secs), attackLast60s: summary(last(attack), Math.min(60, secs)), readers: summary(readers, secs), readersLast60s: summary(last(readers), Math.min(60, secs)) }));
  for (const a of agents.values()) a.destroy();
}

main().catch((e) => {
  process.stderr.write(`[traffic-load] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
