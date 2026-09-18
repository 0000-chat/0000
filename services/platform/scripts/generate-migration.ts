import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAuthMigrationStatements } from "../src/auth-schema";

const output = resolve("migrations/0001_better_auth.sql");
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `-- Generated from Better Auth 1.7.5 core, organization, and OAuth Provider schemas.\n\n${getAuthMigrationStatements().join("\n\n")}\n`,
);
console.log(`Wrote ${output}`);
