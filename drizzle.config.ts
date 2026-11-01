import { defineConfig } from "drizzle-kit";
// SQL generation is offline. Only migration/push operations need credentials.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  ...(process.env.DATABASE_URL
    ? { dbCredentials: { url: process.env.DATABASE_URL } }
    : {}),
});
