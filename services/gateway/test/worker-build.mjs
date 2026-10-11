import { readFile, writeFile } from "node:fs/promises";

const configurationPath = process.argv[2];
if (!configurationPath) {
  throw new Error("A Worker build configuration is required.");
}

const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
if (
  configuration === null ||
  typeof configuration !== "object" ||
  typeof configuration.entrypoint !== "string" ||
  typeof configuration.output !== "string" ||
  !Array.isArray(configuration.external) ||
  !configuration.external.every((item) => typeof item === "string") ||
  configuration.aliases === null ||
  typeof configuration.aliases !== "object" ||
  Array.isArray(configuration.aliases)
) {
  throw new Error("Invalid Worker build configuration.");
}

const aliases = Object.entries(configuration.aliases);
const result = await Bun.build({
  entrypoints: [configuration.entrypoint],
  external: configuration.external,
  format: "esm",
  plugins: [
    {
      name: "gateway-test-package-resolution",
      setup(build) {
        for (const [specifier, path] of aliases) {
          if (typeof path !== "string") {
            throw new Error(`Invalid alias for ${specifier}.`);
          }
          build.onResolve(
            { filter: new RegExp(`^${escapeRegExp(specifier)}$`) },
            () => ({ path }),
          );
        }
      },
    },
  ],
  target: "browser",
});
if (!result.success) {
  throw new Error(result.logs.map((log) => log.message).join("\n"));
}
const output = result.outputs.find((item) => item.kind === "entry-point");
if (!output) throw new Error("The Gateway test build emitted no entry point.");
await writeFile(configuration.output, await output.text(), "utf8");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
