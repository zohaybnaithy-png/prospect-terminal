/**
 * One consistent database state for the snapshot export (snapshot-export.ts).
 *
 * The site's level loaders each open their own READ ONLY, REPEATABLE READ transaction, which
 * makes ONE level consistent but not the set: an export that called them one after another
 * could combine level A from before a commit with level B from after it. Comparing the
 * applied-ingestion version before and after does not close that gap. It only notices commits
 * that also record a completed ingestion run, and it says nothing about direct corrections or any
 * other write.
 *
 * `databaseConsistentRead` instead runs the version probe and every level load inside ONE
 * transaction:
 * - `REPEATABLE READ`: PostgreSQL takes one snapshot at the transaction's first query and gives it
 *   to every later statement, so all reads see exactly the state committed at that instant, and
 *   nothing that commits afterwards;
 * - `READ ONLY`: any write is rejected;
 * - the loaders are unchanged. Inside a transaction, Drizzle runs their own `transaction()` as a
 *   SAVEPOINT, which keeps the outer snapshot (their isolation options apply only to a top-level
 *   transaction). The isolation level and read-only mode are checked at the start, so a driver
 *   change that broke this would fail the export instead of weakening it.
 *
 * Costs: one connection held for the whole export (seconds). Each statement keeps its 30 s
 * `statement_timeout`. The web role's `idle_in_transaction_session_timeout` (60 s) bounds client
 * pauses between statements; decoding a level takes well under a second. Through Neon's pooler
 * (transaction mode) the whole transaction stays on one server connection.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as core from "@/db/schema";
import { loadIngestionVersion } from "@/services/afl/queries";
import { dbLevelLoader } from "./load";
import type { ConsistentRead } from "./snapshot-export";
import { SnapshotIntegrityError } from "./snapshot-store";

type Database = NodePgDatabase<typeof core>;

export function databaseConsistentRead(db: Database, season: number): ConsistentRead {
  return (work) =>
    db.transaction(
      async (tx) => {
        const rows = await tx.execute<{ isolation: string; read_only: string }>(
          sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`,
        );
        const mode = rows.rows[0];
        if (mode?.isolation !== "repeatable read" || mode?.read_only !== "on")
          throw new SnapshotIntegrityError("the export transaction is not READ ONLY, REPEATABLE READ");
        // The loaders accept a database; given this transaction, each of their transactions
        // becomes a savepoint in it (same snapshot).
        const scoped = tx as unknown as Database;
        const load = dbLevelLoader(scoped, season);
        return work({ version: () => loadIngestionVersion(scoped), load });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
}
