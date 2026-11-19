/**
 * Source fingerprint for precomputed view models (views-format.ts). A view model is only valid
 * for the code that computed it, so `npm run snapshot:views` records this hash, `next build`
 * refuses a snapshot whose views came from different source (next.config.ts), and the built
 * server, which carries the hash it was built from, ignores views that do not match it.
 *
 * Deliberately broad: every file under `src/` plus the lockfile. Any change at all invalidates the
 * views, which costs nothing because `npm run build:vercel` recomputes them on every build.
 * Pure Node (no Next.js, no `@/` imports) so next.config.ts can import it.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const files = (root: string, dir: string): string[] =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(root, path.posix.join(dir, e.name)) : e.isFile() ? [path.posix.join(dir, e.name)] : [],
  );

export function sourceFingerprint(root: string = process.cwd()): string {
  const h = createHash("sha256");
  const list = [...files(root, "src"), "package-lock.json"].sort();
  for (const f of list) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(path.join(root, f)));
    h.update("\0");
  }
  return h.digest("hex");
}
