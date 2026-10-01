import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";

import { buildWorkerScript } from "./build-worker";

test("authenticated Gateway profile and use boundary runs through a Worker", async () => {
  const entrypoint = new URL("./authenticated-worker.ts", import.meta.url)
    .pathname;
  const alias = new URL("../src/mcp-use-client-unavailable.ts", import.meta.url)
    .pathname;
  const output = await buildWorkerScript({
    aliases: { "@mcp-use/client": alias },
    entrypoint,
  });
  const directory = await mkdtemp("/tmp/gateway-authenticated-");
  try {
    const workerPath = join(directory, "worker.js");
    await writeFile(workerPath, output, "utf8");
    const result = Bun.spawnSync(
      [
        "node",
        new URL("./authenticated-runtime.mjs", import.meta.url).pathname,
        workerPath,
        new URL("../wrangler.jsonc", import.meta.url).pathname,
        new URL("../migrations/0001_gateway_profiles.sql", import.meta.url)
          .pathname,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        new TextDecoder().decode(result.stderr) ||
          "Authenticated Worker failed.",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
