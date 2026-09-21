import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "bun:test";

const workerEntry = new URL("../src/worker.ts", import.meta.url).pathname;

test("GET /health responds through the Worker runtime", async () => {
  const build = await Bun.build({
    entrypoints: [workerEntry],
    format: "esm",
    target: "browser",
  });

  if (!build.success) {
    throw new Error(build.logs.map((log) => log.message).join("\n"));
  }

  const worker = build.outputs.find((output) => output.kind === "entry-point");
  if (!worker) {
    throw new Error(
      "The Gateway Worker test build did not emit an entry point.",
    );
  }

  const temporaryDirectory = await mkdtemp("/tmp/gateway-health-");
  try {
    const workerPath = join(temporaryDirectory, "worker.js");
    await writeFile(workerPath, await worker.text(), "utf8");
    const result = Bun.spawnSync(
      [
        "node",
        new URL("./miniflare-runtime.mjs", import.meta.url).pathname,
        workerPath,
        new URL("../wrangler.jsonc", import.meta.url).pathname,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    if (result.exitCode !== 0) {
      const error = new TextDecoder().decode(result.stderr);
      throw new Error(error || "The Miniflare health runtime failed.");
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
