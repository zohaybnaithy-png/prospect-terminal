import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import * as schema from "./schema";

const databaseUrl = z
  .string()
  .url()
  .refine(
    (url) => /^postgres(ql)?:/.test(url),
    "Use a PostgreSQL connection URL",
  );
let pool: Pool | undefined;
/** Lazy initialization: importing this module never opens a connection. */
export function getDatabase() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required for database operations. The demo UI does not require it.",
    );
  const connectionString = databaseUrl.parse(process.env.DATABASE_URL);
  pool ??= new Pool({ connectionString, max: 5 });
  return drizzle(pool, { schema });
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
