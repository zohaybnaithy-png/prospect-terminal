/**
 * Phase 5A accessibility regressions. Static checks (no browser, no database): colour tokens and
 * every text colour in globals.css meet WCAG 2.2 AA contrast, links in running text are not told
 * apart by colour alone, focus is always visible, touch targets in the score strip are 24 px, and
 * scrollable tables are keyboard-reachable named regions. Full-page scans of a running site:
 * `npm run a11y:scan` (scripts/ops/a11y-scan.ts).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable } from "../src/components/ui/data-table";
import { ScrollRegion } from "../src/components/ui/scroll-region";
import { LevelNav } from "../src/components/levels/level-nav";
import { MapPointList } from "../src/components/analytics/performance-map";

const ROOT = new URL("..", import.meta.url).pathname;
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// --- WCAG relative luminance / contrast ---------------------------------------------------------
const rgb = (hex: string) => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const tokens: Record<string, string> = {};
for (const m of CSS.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) tokens[m[1]] = m[2];
const resolve = (value: string): string | undefined => {
  const v = value.trim();
  const token = v.match(/^var\(--([\w-]+)\)$/);
  if (token) return tokens[token[1]];
  return v.match(/^#[0-9a-fA-F]{6}\b|^#[0-9a-fA-F]{3}\b/)?.[0];
};

/** Surfaces text sits on: page, panels, table headers, zebra rows, row hover, current rows. */
const SURFACES = ["#ffffff", "#f6f8f8", "#f8faf9", "#f5f7f7", "#f2f6f5", "#edf2f1", "#edf5f3", "#eef5f3"];
/** Selectors whose colour marks an inactive control (exempt from 1.4.3 by definition). */
const INACTIVE = /disabled|aria-disabled/;

interface Rule {
  selector: string;
  color?: string;
  background?: string;
  fontSize?: number;
}
const rules: Rule[] = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selector: sel.trim().replace(/\s+/g, " "),
  color: body.match(/(?:^|[;\s])color:\s*([^;]+)/)?.[1],
  background: body.match(/background(?:-color)?:\s*([^;]+)/)?.[1],
  fontSize: Number(body.match(/font-size:\s*(\d+(?:\.\d+)?)px/)?.[1]) || undefined,
}));

describe("colour contrast (WCAG 1.4.3 / 1.4.11)", () => {
  test("text tokens reach 4.5:1 on every surface", () => {
    for (const name of ["text", "muted", "subtle", "link", "link-hover", "positive", "negative", "warning"]) {
      assert.ok(tokens[name], `--${name} is defined`);
      for (const surface of SURFACES) {
        const r = contrast(tokens[name], surface);
        assert.ok(r >= 4.5, `--${name} ${tokens[name]} on ${surface} is ${r.toFixed(2)}:1`);
      }
    }
  });

  test("the focus ring reaches 3:1 on every surface", () => {
    for (const surface of SURFACES) {
      const r = contrast(tokens.focus, surface);
      assert.ok(r >= 3, `--focus on ${surface} is ${r.toFixed(2)}:1`);
    }
  });

  test("every text colour in globals.css reaches 4.5:1 on its own background, or white", () => {
    const failures: string[] = [];
    for (const r of rules) {
      if (!r.color || INACTIVE.test(r.selector)) continue;
      const fg = resolve(r.color);
      if (!fg || fg.toLowerCase() === "#fff" || fg.toLowerCase() === "#ffffff") continue; // white text: checked by its bg below
      const bg = (r.background && resolve(r.background)) || "#ffffff";
      const ratio = contrast(fg, bg);
      if (ratio < 4.5) failures.push(`${r.selector}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
    }
    assert.deepEqual(failures, []);
  });

  test("white text sits only on backgrounds dark enough for it", () => {
    const failures: string[] = [];
    for (const r of rules) {
      const fg = r.color && resolve(r.color);
      if (!fg || !/^#f{3}(f{3})?$/i.test(fg) || !r.background) continue;
      const bg = resolve(r.background);
      if (bg && contrast("#ffffff", bg) < 4.5) failures.push(`${r.selector} on ${bg}`);
    }
    assert.deepEqual(failures, []);
  });

  test("readable text is never dimmed with opacity (only inactive or loading states)", () => {
    const dimmed = [...CSS.matchAll(/([^{}]+)\{[^{}]*opacity:\s*0?\.\d+/g)]
      .map((m) => m[1].trim().replace(/\s+/g, " "))
      .filter((sel) => !/:disabled|is-pending/.test(sel));
    assert.deepEqual(dimmed, []);
  });

  test("no text below 9px, apart from decorative glyphs", () => {
    const tiny = rules
      .filter((r) => r.fontSize !== undefined && r.fontSize < 9)
      .map((r) => r.selector)
      .filter((sel) => sel !== ".change-arrow");
    assert.deepEqual(tiny, []);
  });
});

describe("links and focus (WCAG 1.4.1 / 2.4.7)", () => {
  test("links inside running text are underlined, not colour-only", () => {
    const prose = CSS.match(/:where\(([^)]*)\)\s*a:not\(\.button-link\):not\(\.reset-button\)\s*\{([^}]*)\}/);
    assert.ok(prose, "prose link rule exists");
    for (const container of ["p", ".table-note", ".afl-notice"])
      assert.ok(prose[1].split(",").map((s) => s.trim()).includes(container), `${container} is covered`);
    assert.match(prose[2], /text-decoration:\s*underline/);
  });

  test("every focusable element gets the shared focus ring, and no rule removes it", () => {
    assert.match(CSS, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\)/);
    // The only outline:none is the header search input, whose frame shows the ring instead.
    const none = [...CSS.matchAll(/([^{}]+)\{[^{}]*outline:\s*none/g)].map((m) => m[1].trim());
    assert.deepEqual(none, [".global-search input"]);
    assert.match(CSS, /\.global-search:focus-within\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  });

  test("small standalone links have a 24px target (WCAG 2.5.8)", () => {
    // Score strip, and the team/org abbreviations in Trends and Recent Leaders lists (found on
    // populated data: short abbreviations 8px apart overlapped each other's 24px spacing zone).
    for (const sel of [".score-strip-label a", ".score-game > div:not(:first-child) > a", ".trending-context a"]) {
      const rule = rules.find((r) => r.selector === sel);
      assert.ok(rule, `${sel} rule exists`);
      const body = CSS.slice(CSS.indexOf(`${sel} {`)).split("}")[0];
      assert.match(body, /min-height:\s*24px/, `${sel} has a 24px minimum height`);
      if (sel === ".trending-context a") assert.match(body, /min-width:\s*24px/, `${sel} has a 24px minimum width`);
    }
  });
});

describe("keyboard access to scrollable content (WCAG 2.1.1)", () => {
  test("scoreboard cards snap, so a focused team link is never left clipped at the edge (2.4.11)", () => {
    assert.match(CSS, /\.score-games\s*\{[^}]*scroll-snap-type:\s*x mandatory/);
    assert.match(CSS, /\.score-game\s*\{[^}]*scroll-snap-align:\s*center/);
  });

  test("ScrollRegion is a named, focusable region", () => {
    const html = renderToStaticMarkup(ScrollRegion({ label: "Game log", children: "x" }));
    assert.match(html, /^<div class="table-scroll" tabindex="0" role="region" aria-label="Game log">/);
  });

  test("DataTable scrolls inside a keyboard-reachable region named by its caption", () => {
    const html = renderToStaticMarkup(
      createElement(DataTable<{ id: string }>, {
        rows: [{ id: "a" }],
        columns: [{ key: "id", label: "Id", render: (r) => r.id }],
        rowKey: (r) => r.id,
        caption: "Batting statistics",
      }),
    );
    assert.match(html, /<div class="table-scroll" tabindex="0" role="region" aria-label="Batting statistics">/);
    assert.match(html, /<caption class="sr-only">Batting statistics<\/caption>/);
  });

  test("no component builds a .table-scroll wrapper by hand", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx") && !path.endsWith("scroll-region.tsx")) {
          if (/className=\{?["'`][^"'`]*\btable-scroll\b/.test(readFileSync(path, "utf8")))
            offenders.push(relative(ROOT, path));
        }
      }
    };
    walk(join(ROOT, "src"));
    assert.deepEqual(offenders, [], "use <ScrollRegion> so the wrapper stays focusable and named");
  });
});

describe("screen-reader text", () => {
  test("disabled level links say why, not only in a hover title", () => {
    const html = renderToStaticMarkup(
      createElement(LevelNav, { basePath: "/trends", current: "aa", available: ["aa"], unavailable: ["aaa"] }),
    );
    assert.match(html, /aria-disabled="true">AAA<span class="sr-only"> \(temporarily unavailable\)<\/span>/);
    assert.match(html, /aria-disabled="true">A\+<span class="sr-only"> \(no 2026 data ingested\)<\/span>/);
  });

  test("the Performance × Momentum map has a keyboard-usable list of its players", () => {
    const point = (id: string, name: string, y: number) => ({
      id,
      name,
      context: "TUL · LAD · SS",
      y,
      x: 80,
      xText: ".900",
      confidence: "High" as never,
      persistenceLevel: "Medium" as never,
      persistenceLabel: "",
      keyChange: "",
      sample: "",
      xs: {},
    });
    const html = renderToStaticMarkup(
      createElement(MapPointList, {
        points: [point("00000000-0000-4000-8000-000000000001", "Low Mover", -20), point("00000000-0000-4000-8000-000000000002", "High Mover", 35)],
        xLabel: "OPS",
        level: "aa",
      }),
    );
    assert.match(html, /<details class="map-points"><summary>List the 2 players on this map<\/summary>/);
    assert.match(html, /role="region"/);
    // Every point is a real link, highest Momentum first.
    // Player links carry the aria-hidden navigation pending hint after their name.
    const names = [...html.matchAll(/<a class="player-name" href="\/players\/[^"]+\?level=aa">([^<]+)(?:<span aria-hidden="true" class="link-hint" data-pending="false"><\/span>)?<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(names, ["High Mover", "Low Mover"]);
  });
});
