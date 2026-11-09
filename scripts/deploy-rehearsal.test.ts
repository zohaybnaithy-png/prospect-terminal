/**
 * Runs deploy/deploy.sh and deploy/rollback.sh for real against a throwaway Git repository in a
 * temporary directory. `npm` is replaced by a stub (install/test do nothing, build writes
 * .next/BUILD_ID), the restart command only records that it ran, and /health is a local server
 * that answers 200 when the release `current` points at contains HEALTH=ok. No network, database
 * or systemd is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const deployDir = new URL("../deploy/", import.meta.url).pathname;

interface Rig {
  root: string;
  src: string;
  run: (script: "deploy.sh" | "rollback.sh", ...args: string[]) => Promise<{ code: number; stderr: string }>;
  commit: (health: "ok" | "bad") => void;
  current: () => string | null;
  releases: () => string[];
  failed: () => string[];
  history: () => string[];
  calls: () => string[];
  setHealth: (release: string, health: "ok" | "bad") => void;
  close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const base = mkdtempSync(join(tmpdir(), "pt-deploy-"));
  const root = join(base, "srv");
  const src = join(base, "src");
  const bin = join(base, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "HEALTH"), "ok\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", "--no-local", src, join(root, "repo"));

  writeFileSync(join(bin, "npm"), '#!/bin/sh\nif [ "$1 $2" = "run build" ]; then mkdir -p .next && echo build > .next/BUILD_ID; fi\n');
  const callsFile = join(base, "calls");
  writeFileSync(join(bin, "restart"), `#!/bin/sh\necho restart >> "${callsFile}"\n`);
  writeFileSync(join(bin, "reset"), `#!/bin/sh\necho reset >> "${callsFile}"\n`);
  for (const f of ["npm", "restart", "reset"]) chmodSync(join(bin, f), 0o755);

  const currentLink = join(root, "current");
  const server: Server = createServer((_req, res) => {
    let ok = false;
    try {
      ok = readFileSync(join(currentLink, "HEALTH"), "utf8").trim() === "ok";
    } catch {}
    res.writeHead(ok ? 200 : 503).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PT_ROOT: root,
    PT_HEALTH_URL: `http://127.0.0.1:${port}/health`,
    PT_HEALTH_TIMEOUT: "1",
    PT_HEALTH_INTERVAL: "0.2",
    PT_RESTART_CMD: join(bin, "restart"),
    PT_RESET_CMD: join(bin, "reset"),
    PT_SKIP_TESTS: "1",
  };
  const list = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
  return {
    root,
    src,
    // Asynchronous so the health server in this process can answer while the script runs.
    run: (script, ...args) =>
      new Promise((resolve) => {
        execFile("bash", [join(deployDir, script), ...args], { env }, (err, _out, stderr) =>
          resolve({ code: err ? Number(err.code ?? 1) : 0, stderr }),
        );
      }),
    commit: (health) => {
      writeFileSync(join(src, "HEALTH"), `${health}\n`);
      writeFileSync(join(src, "n"), String(Math.random()));
      git(src, "add", "-A");
      git(src, "commit", "-q", "-m", health);
    },
    current: () => (existsSync(currentLink) || readlinkOrNull(currentLink) ? readlinkOrNull(currentLink) : null),
    releases: () => list(join(root, "releases")),
    failed: () => list(join(root, "failed")),
    history: () => (existsSync(join(root, "deployments.log")) ? readFileSync(join(root, "deployments.log"), "utf8").trim().split("\n") : []),
    calls: () => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : []),
    setHealth: (release, health) => writeFileSync(join(root, "releases", release, "HEALTH"), `${health}\n`),
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function readlinkOrNull(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

test("deploy rehearsal: a failed first deploy leaves no current release, is recorded, and the next deploy recovers", async () => {
  const r = await rig();
  try {
    r.commit("bad");
    const first = await r.run("deploy.sh");
    assert.equal(first.code, 2, first.stderr);
    assert.match(first.stderr, /no previous release to return to: nothing is being served/);
    assert.equal(r.current(), null, "current must not point at the failed release");
    assert.deepEqual(r.releases(), [], "the failed release is never selectable");
    assert.equal(r.failed().length, 1);
    assert.match(r.history().at(-1)!, /FAILED health check; no previous release, nothing is being served$/);

    r.commit("ok");
    const second = await r.run("deploy.sh");
    assert.equal(second.code, 0, second.stderr);
    assert.equal(r.releases().length, 1);
    assert.equal(r.current(), join(r.root, "releases", r.releases()[0]));
    assert.doesNotMatch(r.history().at(-1)!, /FAILED/);
    // systemd's restart limit is cleared before each restart, so a crash-looped unit starts again.
    const calls = r.calls();
    assert.deepEqual(calls.slice(-2), ["reset", "restart"]);
  } finally {
    await r.close();
  }
});

test("deploy rehearsal: a failed deploy after a healthy one rolls back and records it", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("deploy.sh")).code, 0);
    const good = r.current();
    r.commit("bad");
    const res = await r.run("deploy.sh");
    assert.equal(res.code, 1, res.stderr);
    assert.equal(r.current(), good);
    assert.equal(r.failed().length, 1);
    assert.match(r.history().at(-1)!, new RegExp(`FAILED health check; rolled back to ${basename(good!)}$`));
  } finally {
    await r.close();
  }
});

test("rollback rehearsal: an unhealthy target restores the running release, and a failed restore is reported", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("deploy.sh")).code, 0);
    const [older] = r.releases();
    r.commit("ok");
    assert.equal((await r.run("deploy.sh")).code, 0);
    const running = r.current()!;
    assert.notEqual(basename(running), older);

    // The older release no longer passes its health check: the running one comes back.
    r.setHealth(older, "bad");
    const restored = await r.run("rollback.sh", older);
    assert.equal(restored.code, 1, restored.stderr);
    assert.match(restored.stderr, new RegExp(`restored ${basename(running)}, which is healthy`));
    assert.equal(r.current(), running);
    assert.match(r.history().at(-1)!, new RegExp(`rollback ${older} FAILED health check; restored ${basename(running)}$`));

    // Neither is healthy: the failure of the restore is reported distinctly.
    r.setHealth(basename(running), "bad");
    const down = await r.run("rollback.sh", older);
    assert.equal(down.code, 2, down.stderr);
    assert.match(down.stderr, /restoring .* is not healthy either: the site is down/);
    assert.match(r.history().at(-1)!, /restoring .* also FAILED$/);

    // A healthy target still rolls back normally.
    r.setHealth(older, "ok");
    const ok = await r.run("rollback.sh", older);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(r.current(), join(r.root, "releases", older));
  } finally {
    await r.close();
  }
});
