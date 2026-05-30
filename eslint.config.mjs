import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone laptop bridge (not part of the Next/serverless app): its
    // intentional top-level await + poll loop + node globals aren't valid under
    // the Next browser/TS lint config. Linted out; it's a Node-only script.
    "scripts/**",
  ]),
]);

export default eslintConfig;
