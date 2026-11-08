#!/usr/bin/env node
// Read-only PostgreSQL helper for scripts/ops/milb-week-test.sh, replacing psql with the project's
// `pg` package. It can only read:
//   - the host's endpoint must equal PT_EXPECTED_ENDPOINT (checked again here, not only in bash);
//   - sslmode must be require/verify-full/verify-ca, and the live socket must be TLS with a
//     verified certificate (pg 8 treats sslmode=require as verify-full; uselibpqcompat is refused);
//   - every statement must start with SELECT or WITH and runs inside BEGIN TRANSACTION READ ONLY,
//     which is always rolled back; transaction control in the input is refused.
// The connection string comes from INGESTION_DATABASE_URL and never appears in output or errors.
//
//   node scripts/ops/pg-readonly.mjs query "<sql>"   rows as psql -A -t (columns joined by |)
//   node scripts/ops/pg-readonly.mjs file <path.sql> statements + \echo, as aligned tables
//   node scripts/ops/pg-readonly.mjs selftest        offline parser/guard tests (no database)
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SSL_MODES = new Set(["require", "verify-full", "verify-ca"]);
const ALLOWED_META = [/^\\set\s+QUIET\s+on\s*$/i, /^\\pset\s+footer\s+off\s*$/i];
// The integrity file wraps itself in these; the helper already does, so they are skipped.
// Words that let a SELECT/WITH write or act on the server (statement-level commands such as COMMIT,
// DROP or SET are already refused by the SELECT/WITH first-keyword rule).
const FORBIDDEN = /\b(insert|update|delete|merge|into|nextval|setval|set_config|dblink\w*|lo_\w+|pg_\w+)\b/;
const WRAPPER_STATEMENTS = new Set(["begin transaction read only", "rollback"]);

export class GuardError extends Error {}

/** Splits SQL text into { kind: "sql", text } and { kind: "echo", text } items. */
export function parseScript(source) {
  const items = [];
  let buf = "";
  let i = 0;
  let atLineStart = true;
  const flush = () => {
    const text = buf.trim();
    if (text) items.push({ kind: "sql", text });
    buf = "";
  };
  while (i < source.length) {
    const c = source[i];
    const eol = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
    if (atLineStart && buf.trim() === "" && /^[ \t]*\\/.test(source.slice(i, eol))) {
      const end = eol;
      const line = source.slice(i, end).trim();
      i = end + 1;
      atLineStart = true;
      const echo = /^\\echo\s+(.*)$/i.exec(line);
      if (echo) {
        const arg = echo[1].trim();
        items.push({ kind: "echo", text: /^'.*'$/.test(arg) ? arg.slice(1, -1).replace(/''/g, "'") : arg });
      } else if (!ALLOWED_META.some((re) => re.test(line))) {
        throw new GuardError(`psql meta-command not supported: ${line.split(/\s/)[0]}`);
      }
      continue;
    }
    if (c === "-" && source[i + 1] === "-") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new GuardError("unterminated block comment");
      buf += " ";
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= source.length) throw new GuardError("unterminated quoted string");
        if (source[j] === c) {
          if (source[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      buf += source.slice(i, j + 1);
      i = j + 1;
      atLineStart = false;
      continue;
    }
    if (c === "$" && /^\$[A-Za-z_]*\$/.test(source.slice(i))) {
      throw new GuardError("dollar-quoted strings are not supported");
    }
    if (c === ";") {
      flush();
      i++;
      atLineStart = false;
      continue;
    }
    buf += c;
    atLineStart = c === "\n";
    i++;
  }
  flush();
  return items;
}

const normalize = (sql) => sql.replace(/\s+/g, " ").trim().toLowerCase();

/** Returns "skip" for the file's own read-only wrapper, "run" for a read, or throws. */
export function classify(sql) {
  const n = normalize(sql);
  if (WRAPPER_STATEMENTS.has(n)) return "skip";
  if (!/^(select|with)\b/.test(n)) {
    throw new GuardError(`only SELECT/WITH statements are allowed (got: ${n.split(" ")[0]})`);
  }
  // Second layer under the READ ONLY transaction: no write/DDL/session keywords or admin functions
  // anywhere outside string literals (catches data-modifying CTEs before anything is sent).
  const code = n.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const bad = FORBIDDEN.exec(code);
  if (bad) throw new GuardError(`forbidden keyword in read-only query: ${bad[0]}`);
  return "run";
}

/** Validates the connection string; returns the endpoint id. */
export function checkTarget(url, expectedEndpoint) {
  if (!url) throw new GuardError("INGESTION_DATABASE_URL is not set");
  if (!expectedEndpoint) throw new GuardError("PT_EXPECTED_ENDPOINT is not set");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("INGESTION_DATABASE_URL is not a valid URL");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new GuardError("not a postgres URL");
  const endpoint = u.hostname.split(".")[0].replace(/-pooler$/, "");
  if (endpoint !== expectedEndpoint) throw new GuardError(`endpoint ${endpoint} is not ${expectedEndpoint}`);
  const sslmode = u.searchParams.get("sslmode") ?? "";
  if (!SSL_MODES.has(sslmode)) throw new GuardError("connection string must set sslmode=require");
  if (u.searchParams.has("uselibpqcompat")) throw new GuardError("uselibpqcompat would weaken certificate verification");
  return endpoint;
}

function redact(message, url) {
  let out = String(message ?? "");
  try {
    const u = new URL(url);
    for (const secret of [url, decodeURIComponent(u.password), u.password, decodeURIComponent(u.username), u.username]) {
      if (secret && secret.length >= 3) out = out.split(secret).join("<redacted>");
    }
  } catch {}
  return out;
}

const cell = (v) => (v === null || v === undefined ? "" : String(v));

function formatTable(fields, rows) {
  const names = fields.map((f) => f.name);
  const cells = rows.map((r) => r.map(cell));
  const widths = names.map((n, k) => Math.max(n.length, ...cells.map((r) => r[k].length)));
  const line = (vals) => " " + vals.map((v, k) => v.padEnd(widths[k])).join(" | ").trimEnd();
  return [line(names), widths.map((w) => "-".repeat(w + 2)).join("+"), ...cells.map(line)].join("\n");
}

async function connect(url) {
  const { default: pg } = await import("pg");
  // Raw text for every type, exactly as psql prints it (no JS Date/number conversion).
  const types = { getTypeParser: () => (value) => value };
  const client = new pg.Client({ connectionString: url, types, query_timeout: 120_000, connectionTimeoutMillis: 30_000 });
  await client.connect();
  const stream = client.connection?.stream;
  if (!stream || stream.encrypted !== true || stream.authorized !== true) {
    await client.end().catch(() => {});
    throw new GuardError("connection is not TLS with a verified server certificate");
  }
  return client;
}

async function runReadOnly(url, items, mode) {
  // Validate everything before connecting, so a bad statement never reaches the database.
  const plan = items.map((it) => (it.kind === "sql" ? { ...it, action: classify(it.text) } : it));
  const client = await connect(url);
  try {
    await client.query("begin transaction read only");
    const ro = await client.query("show transaction_read_only");
    if (ro.rows[0]?.transaction_read_only !== "on") throw new GuardError("transaction is not read-only");
    const out = [];
    for (const it of plan) {
      if (it.kind === "echo") { out.push(it.text); continue; }
      if (it.action === "skip") continue;
      const res = await client.query({ text: it.text, rowMode: "array" });
      if (mode === "query") {
        for (const r of res.rows) out.push(r.map(cell).join("|"));
      } else {
        out.push(formatTable(res.fields, res.rows), "");
      }
    }
    await client.query("rollback");
    process.stdout.write(out.length ? out.join("\n") + "\n" : "");
  } finally {
    await client.end().catch(() => {});
  }
}

function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`selftest failed: ${msg}`); };
  const throws = (fn, msg) => { try { fn(); } catch (e) { if (e instanceof GuardError) return; throw e; } throw new Error(`selftest failed: expected refusal: ${msg}`); };
  const ok = "postgresql://u:p4ss@ep-spring-cake-ak5jqlqp-pooler.c-0.example-region.aws.neon.tech/db?sslmode=require";
  assert(checkTarget(ok, "ep-spring-cake-ak5jqlqp") === "ep-spring-cake-ak5jqlqp", "accepts test endpoint");
  throws(() => checkTarget(ok.replace("spring-cake", "other-prod"), "ep-spring-cake-ak5jqlqp"), "wrong endpoint");
  throws(() => checkTarget(ok.replace("ak5jqlqp", "ak5jqlqpx"), "ep-spring-cake-ak5jqlqp"), "endpoint prefix match");
  throws(() => checkTarget(ok.replace("?sslmode=require", ""), "ep-spring-cake-ak5jqlqp"), "no sslmode");
  throws(() => checkTarget(ok.replace("require", "disable"), "ep-spring-cake-ak5jqlqp"), "sslmode=disable");
  throws(() => checkTarget(ok.replace("require", "prefer"), "ep-spring-cake-ak5jqlqp"), "sslmode=prefer");
  throws(() => checkTarget(ok + "&uselibpqcompat=true", "ep-spring-cake-ak5jqlqp"), "libpq compat");
  throws(() => checkTarget(ok, ""), "no expected endpoint");
  throws(() => checkTarget("", "ep-spring-cake-ak5jqlqp"), "no url");
  throws(() => checkTarget(ok.replace("spring-cake-ak5jqlqp", "lucky-sea-akc835g5"), "ep-spring-cake-ak5jqlqp"), "retired test endpoint");
  for (const bad of ["insert into games values (1)", "update games set x=1", "delete from games", "drop table games",
    "truncate games", "commit", "end", "begin", "set transaction read write", "copy games to stdout", "call f()",
    "with x as (delete from games returning 1) select 1", "with x as (update games set a = 1 returning 1) select * from x",
    "select * into t from games", "select pg_terminate_backend(1)", "select set_config('a', 'b', false)",
    "select nextval('s')"]) {
    throws(() => classify(bad), bad);
  }
  assert(classify("select 'delete; drop' as x, updated_at, deleted from t") === "run", "keywords in strings/identifiers ok");
  assert(classify("select 1") === "run" && classify("  WITH x as (select 1) select * from x") === "run", "allows reads");
  assert(classify("BEGIN TRANSACTION  READ ONLY") === "skip" && classify("rollback") === "skip", "wrapper skipped");
  const items = parseScript("\\set QUIET on\n\\echo '== 1. a; b'\nselect ';' as x; -- c; d\nselect 2 /* ; */;\n");
  assert(items.length === 3 && items[0].kind === "echo" && items[0].text === "== 1. a; b", "echo parsed");
  assert(items[1].text === "select ';' as x" && items[2].text.replace(/\s+/g, " ") === "select 2", "split on ; outside quotes/comments");
  throws(() => parseScript("\\copy games to 'x'\n"), "unsupported meta");
  throws(() => parseScript("\\! rm -rf x\n"), "shell escape");
  throws(() => parseScript("select 1; delete from games;").forEach((it) => classify(it.text)), "write hidden after read");
  throws(() => parseScript("select 1 from x where y = 'unterminated"), "unterminated quote");
  throws(() => parseScript("select $$x$$"), "dollar quote");
  const file = parseScript(fs.readFileSync(new URL("../sql/milb-integrity-checks.sql", import.meta.url), "utf8"));
  file.forEach((it) => it.kind === "sql" && classify(it.text));
  assert(file.filter((it) => it.kind === "echo").length === 9, "integrity file has 9 sections");
  const msg = redact(`password authentication failed for user "u" at ${ok} (p4ss)`, ok);
  assert(!msg.includes("p4ss") && !msg.includes(ok), "errors are redacted");
  console.log("pg-readonly selftest: ok");
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  if (mode === "selftest") return selftest();
  const url = process.env.INGESTION_DATABASE_URL ?? "";
  try {
    checkTarget(url, process.env.PT_EXPECTED_ENDPOINT ?? "");
    if (mode === "query" && arg) {
      const items = parseScript(arg);
      if (items.length !== 1 || items[0].kind !== "sql") throw new GuardError("query mode takes exactly one statement");
      await runReadOnly(url, items, "query");
    } else if (mode === "file" && arg) {
      await runReadOnly(url, parseScript(fs.readFileSync(arg, "utf8")), "file");
    } else {
      throw new GuardError("usage: pg-readonly.mjs query <sql> | file <path> | selftest");
    }
  } catch (e) {
    const kind = e instanceof GuardError ? "refused" : `error${e?.code ? ` ${e.code}` : ""}`;
    process.stderr.write(`pg-readonly ${kind}: ${redact(e?.message, url)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
