import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema";

// Build-safe placeholder used only when DATABASE_URL is unset at module load.
// `postgres()` is lazy — it doesn't open a connection until a query runs —
// so constructing the client with this URL is harmless during `next build`.
// Any attempt to actually query at runtime without a real DATABASE_URL will
// fail when the client tries to connect; `getDb()` callers get a clear error
// up-front via the explicit guard below.
const BUILD_PLACEHOLDER_URL = "postgres://noop:noop@127.0.0.1:5432/noop";

const url = process.env.DATABASE_URL ?? BUILD_PLACEHOLDER_URL;
const client: Sql = postgres(url, { max: 1 });

export const db: PostgresJsDatabase<typeof schema> = drizzle(client, {
  schema,
});

export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Set it in .env.local for local dev, or in the deploy platform's env config.",
    );
  }
  return db;
}

export { schema };
