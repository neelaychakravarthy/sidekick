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
    url: process.env.DATABASE_URL ?? "",
  },
});
