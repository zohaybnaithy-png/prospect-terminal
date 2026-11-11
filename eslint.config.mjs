import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "next-env.d.ts", "drizzle/**"]),
  {
    // Prefetching is off by default (src/components/ui/app-link.tsx, docs/VERCEL.md): every Link
    // must come from that wrapper.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/app-link.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "next/link", message: "Import Link from @/components/ui/app-link (prefetch off by default)." }] },
      ],
    },
  },
]);
