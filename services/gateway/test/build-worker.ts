import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerBuildRequest {
  readonly entrypoint: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly external?: readonly string[];
}

/**
 * Keep each Worker bundle in its own Bun process. Bun's in-process bundler
 * cache can reuse module state between Miniflare fixtures and emit duplicate
 * declarations when several Worker entry points are built by one test run.
 */
export async function buildWorkerScript(
  request: WorkerBuildRequest,
): Promise<string> {
  const directory = await mkdtemp("/tmp/gateway-worker-build-");
  const configurationPath = join(directory, "configuration.json");
  const outputPath = join(directory, "worker.js");
  try {
    await writeFile(
      configurationPath,
      JSON.stringify({
        entrypoint: request.entrypoint,
        aliases: request.aliases,
        external: request.external ?? ["cloudflare:workers"],
        output: outputPath,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(new URL("./worker-build.mjs", import.meta.url)),
        configurationPath,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        new TextDecoder().decode(result.stderr) ||
          "The isolated Gateway Worker build failed.",
      );
    }
    return await readFile(outputPath, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
