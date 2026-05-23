import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

let cachedDb: PostgresJsDatabase<typeof schema> | null = null;

export function getDb() {
  if (cachedDb) return cachedDb;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Set it in .env.local for local dev, or in the deploy platform's env config.",
    );
  }
  const client = postgres(url, { max: 1 });
  cachedDb = drizzle(client, { schema });
  return cachedDb;
}

export { schema };
