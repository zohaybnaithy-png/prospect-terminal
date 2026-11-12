/**
 * Phase 2A navigation: client router cache (next.config.ts `staleTimes.dynamic`) and the inline
 * pending hint (src/components/ui/link-pending-hint.tsx). Browser behaviour is covered end to end
 * by scripts/navigation.e2e.ts; these tests pin the configuration and the guard rails.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = new URL("..", import.meta.url);
const src = (p: string) => readFileSync(new URL(p, root), "utf8");
const files = (dir: string): string[] =>
  readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
  );

describe("router cache", () => {
  test("dynamic pages are kept in the browser's router cache for 300 s; the static default is unchanged", async () => {
    const mod = await import("../next.config");
    assert.equal(mod.ROUTER_CACHE_DYNAMIC_SECONDS, 300);
    const config = mod.default("phase-production-server");
    assert.deepEqual(config.experimental?.staleTimes, { dynamic: 300 });
  });

  test("no aggressive prefetching: the wrapper still defaults to prefetch off and nothing opts in", async () => {
    const { default: Link } = await import("../src/components/ui/app-link");
    const el = Link({ href: "/players", children: "x" }) as { props: { prefetch: unknown } };
    assert.equal(el.props.prefetch, false);
    for (const f of files("src").filter((f) => /\.tsx?$/.test(f))) {
      const code = src(f);
      assert.doesNotMatch(code, /prefetch=\{(true|null|"auto")\}/, f);
      assert.doesNotMatch(code, /router\.prefetch\(/, f);
    }
  });

  test("no loading.tsx: streaming would fix the status at 200 and turn unknown-player 404s into soft 404s", () => {
    const loading = files("src/app").filter((f) => /\/loading\.(t|j)sx?$/.test(f));
    assert.deepEqual(loading, []);
  });
});

describe("pending hint", () => {
  test("app-link re-exports Next.js useLinkStatus (no second import path for next/link)", async () => {
    const appLink = await import("../src/components/ui/app-link");
    const next = await import("next/link");
    assert.equal(appLink.useLinkStatus, next.useLinkStatus);
    assert.match(src("src/components/ui/link-pending-hint.tsx"), /^"use client";/);
    assert.match(src("src/components/ui/link-pending-hint.tsx"), /from "@\/components\/ui\/app-link"/);
  });

  test("renders a fixed, aria-hidden element that is not pending outside a navigation", async () => {
    const { LinkPendingHint } = await import("../src/components/ui/link-pending-hint");
    const html = renderToStaticMarkup(createElement(LinkPendingHint));
    assert.equal(html, '<span aria-hidden="true" class="link-hint" data-pending="false"></span>');
  });

  test("the header tabs and player-name links carry the hint", () => {
    const header = src("src/components/layout/header.tsx");
    const nav = header.slice(header.indexOf('<nav aria-label="Main navigation">'), header.indexOf("</nav>"));
    assert.match(nav, /\{label\}\s*<LinkPendingHint \/>\s*<\/Link>/);
    assert.match(src("src/components/ui/entity-links.tsx"), /\{player\.name\}\s*<LinkPendingHint \/>\s*<\/Link>/);
  });

  test("CSS: no layout shift, hidden for the first 150 ms, reduced motion respected, text never dimmed", () => {
    const css = src("src/app/globals.css");
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    assert.match(rule("a:has(> .link-hint)"), /position:\s*relative/);
    const base = rule(".link-hint");
    assert.match(base, /position:\s*absolute/);
    assert.match(base, /opacity:\s*0;/);
    assert.match(base, /pointer-events:\s*none/);
    assert.match(rule('.link-hint[data-pending="true"]'), /link-hint-show 0s linear 150ms forwards/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.link-hint\[data-pending="true"\]\s*\{\s*animation: link-hint-show 0s linear 150ms forwards;/);
  });
});
