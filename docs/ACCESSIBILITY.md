# Accessibility

Target: **WCAG 2.2 AA** across every page, at desktop and phone widths, without changing the light,
dense, Savant/FanGraphs-style design.

## Conventions

| Need | Use | Why |
| --- | --- | --- |
| Text colour | `var(--text)`, `var(--muted)` (secondary), `var(--subtle)` (tertiary: ranks, units, timestamps), `--link`, `--positive`, `--negative`, `--warning` | Each token is ≥ 4.5:1 on white **and** on every tinted surface (table headers, zebra rows, row hover). Don't add new hex greys for text; lighter greys fail on those surfaces. |
| Inactive controls | `var(--disabled)` | Only for controls that do nothing (exempt from 1.4.3). Never for readable content. |
| De-emphasis | Smaller size or weight | Never `opacity` on readable text: it silently cuts contrast. |
| Minimum type size | 9 px | Only decorative, `aria-hidden` glyphs may be smaller. |
| Links in sentences | Automatic underline inside `p`, `.table-note`, `.afl-notice`, `.mixed-level-note`, method lists and glossary | WCAG 1.4.1: link colour alone is only ~2:1 against body text. Standalone links (navigation, tables, lists, controls) stay plain. Add a container to the `:where(...)` list in `globals.css` if a new prose block holds links. |
| Focus | Global `:focus-visible` ring (`--focus`, 2 px) | Never set `outline: none` without giving a parent a ring (see `.global-search:focus-within`). |
| Scrolling tables | `<ScrollRegion label=…>` (`src/components/ui/scroll-region.tsx`) or `DataTable` | A focusable, named region, so keyboard users can scroll a table that has no links (WCAG 2.1.1). Never hand-write `className="table-scroll"`. |
| Sticky headers | `.table-scroll` and pages with `.profile-tabs` set `scroll-padding-top` | Focused elements never land under sticky headers or tabs (WCAG 2.4.11). |
| Small links | Keep a 24 px hit area (`min-height: 24px`) or 24 px between targets | WCAG 2.5.8; inline links in sentences are exempt. |
| Charts | Wrapper with `role="img"` and a text summary; a keyboard route to anything clickable | The Performance × Momentum map lists its players in a collapsed table under the chart. |
| Hover-only info | Repeat it in visible or `sr-only` text | `title` tooltips aren't available to keyboard or most screen-reader users (e.g. disabled level links say why in `sr-only` text). |

## Checks

- `npm test` runs `scripts/accessibility.test.ts`: contrast of every token and every text colour in
  `globals.css`, no dimmed text, minimum type size, prose-link underline, focus ring, score-strip
  target size, `ScrollRegion`/`DataTable` markup, and the screen-reader text above. No browser or
  database needed.
- `npm run a11y:scan` scans a **running** site with axe-core (WCAG 2.0–2.2 A/AA) at 1366 px and
  390 px, as loaded and with every disclosure and the phone filter panel open. It reports violations,
  axe's "needs review" items and horizontal page overflow. Read-only; point it at a local build with a
  disposable development database (e.g. fixture data), never at production:

  ```bash
  npm run build && DATABASE_URL=<disposable dev db> npm start
  A11Y_BASE_URL=http://localhost:3000 npm run -s a11y:scan > /tmp/a11y.json
  ```

  `A11Y_STRICT=1` exits 1 on any violation; `A11Y_PATHS` adds paths; `A11Y_BROWSER` points at a
  Chromium binary if Playwright's own is not installed.

Expected "needs review" items that are not failures: decorative Momentum/change arrows (same colour
as the passing number beside them) and Recharts axis labels (axe cannot read the SVG background; the
tick colour is 4.9:1 on white).

## Not covered by automation

Screen-reader announcement quality (VoiceOver/NVDA), Windows High Contrast / forced colours (selected
toggles and tabs get an outline there, untested on Windows), 200–400 %
zoom and text-spacing overrides, and real-data volume (the scan above ran on the small synthetic
fixtures). Check these manually before launch.
