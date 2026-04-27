import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { env } from "../config/index.js";
import type { DB } from "./types.js";

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("pg pool error", err);
});

// Each pooled Client emits its own "error" events when the upstream connection
// dies (e.g. Supabase idle-evicting a connection). Without this listener, a
// dropped client kills the whole node process.
pool.on("connect", (client) => {
  client.on("error", (err) => {
    console.error("pg client error (connection will be replaced)", err.message);
  });
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
  log: env.NODE_ENV === "development" ? ["error"] : ["error"],
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}
