/**
 * Static checks of the deployment files in deploy/ (no server needed): the pieces agree on ports,
 * paths and the health check, the templates carry no secrets, and the database role is read-only.
 * The files are also validated on the server with their own tools (see docs/DEPLOYMENT-RUNBOOK.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(`../deploy/${f}`, import.meta.url), "utf8");
const service = read("prospect-terminal.service");
const caddy = read("Caddyfile");
const common = read("common.sh");
const env = read("env.example");
const sql = read("neon-readonly-role.sql");

test("deploy: service, proxy and health check agree on the app's address", () => {
  assert.match(service, /next start --hostname 127\.0\.0\.1 --port 3000\b/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000\b/);
  assert.match(common, /PT_HEALTH_URL:-http:\/\/127\.0\.0\.1:3000\/health\}/);
  assert.match(service, /WorkingDirectory=\/srv\/prospect-terminal\/current\b/);
  assert.match(common, /PT_ROOT:-\/srv\/prospect-terminal\}/);
  assert.match(common, /systemctl restart prospect-terminal\}"/);
});

test("deploy: the service runs unprivileged, restarts, and reads secrets only from the env file", () => {
  for (const line of ["User=prospect", "Restart=always", "NoNewPrivileges=true", "EnvironmentFile=/etc/prospect-terminal/env", "Environment=NODE_ENV=production"])
    assert.ok(service.includes(line), line);
  assert.match(service, /--max-old-space-size=1536/);
  assert.doesNotMatch(service, /DATABASE_URL=/, "no credentials in the unit file");
});

test("deploy: templates contain placeholders, never credentials", () => {
  const url = /DATABASE_URL=(\S+)/.exec(env)?.[1] ?? "";
  assert.match(url, /^postgresql:\/\/pt_web:REPLACE_WITH_PASSWORD@ep-REPLACE-pooler\./);
  assert.match(url, /sslmode=require/);
  assert.doesNotMatch(env, /npg_[A-Za-z0-9]+/, "no Neon-style password");
  assert.match(sql, /PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'/);
  assert.match(caddy, /prospectterminal\.example/, "the domain is a placeholder until DNS exists");
});

test("deploy: the web role SQL grants only reads and forces read-only sessions", () => {
  // The statements that change anything (the trailing SELECTs only verify).
  const statements = sql.split("-- Verify")[0].replace(/--.*$/gm, "");
  assert.ok(sql.includes("-- Verify"));
  assert.doesNotMatch(statements, /GRANT\s+(?!CONNECT|USAGE|SELECT)\w+/i);
  assert.doesNotMatch(statements, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER TABLE|CREATEDB|CREATEROLE|SUPERUSER)\b/i);
  assert.match(statements, /ALTER ROLE pt_web SET default_transaction_read_only = on/);
  assert.match(statements, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO pt_web/);
});

test("deploy: scripts parse, and refuse unsafe refs and release names", () => {
  for (const f of ["common.sh", "deploy.sh", "rollback.sh"])
    execFileSync("bash", ["-n", new URL(`../deploy/${f}`, import.meta.url).pathname]);
  const deploy = read("deploy.sh");
  const rollback = read("rollback.sh");
  assert.match(deploy, /^set -euo pipefail$/m);
  assert.match(rollback, /^set -euo pipefail$/m);
  assert.match(deploy, /case "\$ref" in -\*\|\*\.\.\*/);
  assert.match(rollback, /case "\$1" in \*\/\*\|\.\*\) die/);
  // The deploy user may run exactly two root commands: restart the app, and clear its restart limit.
  const sudo = read("sudoers-prospect-terminal").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  assert.deepEqual(sudo, [
    "prospect ALL=(root) NOPASSWD: /usr/bin/systemctl restart prospect-terminal",
    "prospect ALL=(root) NOPASSWD: /usr/bin/systemctl reset-failed prospect-terminal",
  ]);
  // A failed release leaves releases/ so a later rollback can never select it.
  assert.match(deploy, /mv "\$release" "\$failed"/);
});

test("deploy: the runbook's `shellcheck -x deploy/*.sh` check is clean (Phase 6A)", () => {
  // Before Phase 6A the runbook said "no output = OK" but shellcheck reported SC2148 (error) and
  // three notes, so an operator would have stopped at step 2.4.
  assert.match(common, /^# shellcheck shell=bash$/m);
  for (const f of ["deploy.sh", "rollback.sh", "common.sh"]) assert.doesNotMatch(read(f), /\bls -1d\b/, f);
  let installed = true;
  try {
    execFileSync("shellcheck", ["--version"], { stdio: "pipe" });
  } catch {
    installed = false; // the static checks above still run; the server has shellcheck (runbook 2.2)
  }
  if (installed) {
    const out = execFileSync("bash", ["-c", "shellcheck -x deploy/*.sh 2>&1 || true"], { cwd: new URL("..", import.meta.url).pathname }).toString();
    assert.equal(out, "", out);
  }
});

test("deploy: deploy.sh installs dev dependencies and never builds during a data refresh (Phase 6A)", () => {
  const deploy = read("deploy.sh");
  assert.match(deploy, /npm ci --include=dev/);
  assert.match(deploy, /PT_REFRESH_ACTIVE_CMD/);
  assert.match(common, /systemctl is-active --quiet prospect-terminal-refresh\.service/);
});

test("deploy: the staging Caddyfile matches production in every block the rehearsal tests (Phase 6A)", () => {
  const staging = read("Caddyfile.staging");
  const block = (text: string, start: RegExp) => {
    const i = text.search(start);
    assert.ok(i >= 0, String(start));
    let depth = 0;
    for (let j = text.indexOf("{", i); j < text.length; j++) {
      if (text[j] === "{") depth++;
      if (text[j] === "}" && --depth === 0) return text.slice(i, j + 1);
    }
    throw new Error("unbalanced");
  };
  for (const start of [/^\{$/m, /reverse_proxy 127\.0\.0\.1:3000 \{/, /request_body \{/, /log \{/])
    assert.equal(block(staging, start), block(caddy, start), String(start));
  // Private: basic auth on everything except /health; never a real hash in the repository.
  assert.match(staging, /@private not path \/health\n\tbasicauth @private \{\n\t\tstaging REPLACE_WITH_CADDY_HASH_PASSWORD_OUTPUT\n/);
  assert.match(staging, /X-Robots-Tag "noindex, nofollow"/);
  assert.doesNotMatch(staging, /\$2[aby]\$/, "no bcrypt hash committed");
});

test("deploy: the ingestion env template pins the write target and holds no credentials (Phase 6A)", () => {
  const ingest = read("ingest-env.example");
  assert.match(ingest, /^INGESTION_DATABASE_URL=postgresql:\/\/pt_ingest:REPLACE_WITH_PASSWORD@ep-REPLACE-pooler\./m);
  assert.match(ingest, /^PT_WRITE_TARGET_ENDPOINT=ep-REPLACE$/m);
  assert.doesNotMatch(ingest, /npg_[A-Za-z0-9]+/);
  assert.match(read("prospect-terminal-refresh.service"), /^EnvironmentFile=\/etc\/prospect-terminal-ingest\/env$/m);
  // The web server's template never carries the writer credential.
  assert.doesNotMatch(env.replace(/^#.*$/gm, ""), /INGESTION_DATABASE_URL|PT_WRITE_TARGET/);
  assert.match(env, /^# PT_INDEXING=off$/m, "staging switch documented, off by default");
});

test("deploy: a deploy and a data refresh never overlap, in either direction (Phase 6A)", () => {
  const refresh = read("prospect-terminal-refresh.service");
  // The refresh is skipped while deploy.sh holds its lock directory ...
  assert.match(refresh, /^ExecCondition=\/bin\/sh -c '! test -d \/srv\/prospect-terminal\/\.deploy\.lock'$/m);
  assert.match(common, /mkdir "\$PT_ROOT\/\.deploy\.lock"/, "the same directory deploy.sh takes");
  assert.match(common, /PT_ROOT="\$\{PT_ROOT:-\/srv\/prospect-terminal\}"/);
  // ... and deploy.sh refuses to build while the refresh unit is active (rehearsal-tested).
  assert.match(common, /prospect-terminal-refresh\.service/);
  // Memory caps that keep a 4 GB host safe (app 3G hard cap, refresh 1.5G, monitor 300M).
  assert.match(service, /^MemoryMax=3G$/m);
  assert.match(refresh, /^MemoryMax=1500M$/m);
  assert.match(read("prospect-terminal-monitor.service"), /^MemoryMax=300M$/m);
  assert.match(read("prospect-terminal-monitor.timer"), /^OnUnitActiveSec=5min$/m);
  assert.doesNotMatch(read("deploy.sh"), /monitor\.timer|refresh\.timer/, "deploy never enables schedules");
});
