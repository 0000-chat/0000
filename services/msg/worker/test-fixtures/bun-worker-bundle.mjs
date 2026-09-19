import { stat } from "node:fs/promises";

const MAX_LOG_MESSAGE_LENGTH = 1_000;

function truncate(value) {
  const text = String(value);
  return text.length <= MAX_LOG_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_LOG_MESSAGE_LENGTH)}…`;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseConfiguration() {
  const value = JSON.parse(process.argv[2] ?? "null");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Worker bundle configuration.");
  if (typeof value.entrypoint !== "string" || typeof value.outdir !== "string") throw new Error("Worker bundle configuration is missing paths.");
  if (!Array.isArray(value.external) || !value.external.every((entry) => typeof entry === "string")) throw new Error("Worker bundle configuration has invalid externals.");
  if (typeof value.format !== "string" || typeof value.naming !== "string" || typeof value.target !== "string") throw new Error("Worker bundle configuration has invalid build options.");
  return value;
}

try {
  if (typeof Bun === "undefined") throw new Error("The Worker bundle child must run under Bun.");
  const configuration = parseConfiguration();
  const result = await Bun.build({
    entrypoints: [configuration.entrypoint],
    external: configuration.external,
    format: configuration.format,
    naming: configuration.naming,
    outdir: configuration.outdir,
    target: configuration.target,
  });
  if (!result.success) {
    send({
      type: "error",
      message: "Bun Worker bundle failed.",
      logs: result.logs.slice(0, 8).map((log) => ({ level: String(log.level ?? "error"), message: truncate(log.message) })),
    });
    process.exitCode = 1;
  } else {
    const entry = result.outputs.find((output) => output.kind === "entry-point");
    if (!entry) throw new Error("The Worker bundle did not emit an entry point.");
    const output = await stat(entry.path);
    send({ type: "success", outputPath: entry.path, byteLength: output.size });
  }
} catch (error) {
  send({ type: "error", message: truncate(error instanceof Error ? error.message : String(error)) });
  process.exitCode = 1;
}
