import { defineConfig } from "drizzle-kit";

// Next.js auto-loads .env.local for the app runtime, but drizzle-kit
// only reads .env by default. Bridge them so `pnpm db:push` etc. pick
// up the same DATABASE_URL the app uses.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // .env.local is optional; fall back to .env / process env
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Neon exposes a pooled (pgBouncer, "-pooler" host) connection for
    // serverless runtime and a direct/unpooled one for DDL. drizzle-kit push
    // runs DDL, which can fail over the pooler — so prefer DIRECT_DATABASE_URL
    // for migrations when set, falling back to DATABASE_URL otherwise.
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
});
