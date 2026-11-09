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
  // A failed release leaves releases/ so a later rollback can never select it.
  assert.match(deploy, /mv "\$release" "\$failed"/);
});
