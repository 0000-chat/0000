import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

const [workerPath, configPath] = process.argv.slice(2);
if (!workerPath || !configPath) {
  throw new Error(
    "Worker script and Wrangler configuration paths are required.",
  );
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const runtime = new Miniflare({
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  modules: true,
  script: await readFile(workerPath, "utf8"),
});

try {
  const response = await runtime.dispatchFetch(
    "https://gateway.0000.chat/health",
  );
  if (response.status !== 200) {
    throw new Error(`Expected /health to return 200, got ${response.status}.`);
  }

  const body = await response.json();
  if (
    JSON.stringify(body) !==
    JSON.stringify({ status: "ok", service: "gateway" })
  ) {
    throw new Error(`Unexpected /health response: ${JSON.stringify(body)}`);
  }
} finally {
  await runtime.dispose();
}
