import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedBindings = [
  { name: "MSG_RATE_LIMIT_CREATION", limit: 6 },
  { name: "MSG_RATE_LIMIT_READS", limit: 60 },
  { name: "MSG_RATE_LIMIT_POSTS", limit: 20 },
  { name: "MSG_RATE_LIMIT_LIVE", limit: 10 },
] as const;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function option(
  args: readonly string[],
  name: string,
  required: boolean,
): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required)
      throw new Error(
        `Usage: bun ${fileURLToPath(import.meta.url)} --0000-root /path/to/0000 [--policy /path/to/policy.json]`,
      );
    return undefined;
  }
  if (
    args.indexOf(name, index + 1) !== -1 ||
    index + 1 >= args.length ||
    args[index + 1]?.startsWith("--")
  ) {
    throw new Error(`Option ${name} requires exactly one value.`);
  }
  return args[index + 1];
}

function assertNoUnknownOptions(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--0000-root" || value === "--policy") {
      index += 1;
      continue;
    }
    throw new Error(`Unknown option ${value}.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertNoUnknownOptions(args);
  const rootOption = option(args, "--0000-root", true);
  if (!rootOption) throw new Error("The --0000-root option is required.");
  const monorepoRoot = resolve(rootOption);
  const policyPath = resolve(
    option(args, "--policy", false) ??
      join(scriptDirectory, "msg-rate-limit-policy.json"),
  );
  const policyModulePath = join(
    monorepoRoot,
    "services/msg/scripts/msg-rate-limit-policy.ts",
  );
  const {
    buildMsgMiniflareRateLimits,
    buildMsgWranglerRateLimits,
    parseMsgRateLimitPolicyJson,
  } = await import(pathToFileURL(policyModulePath).href);
  const policy = parseMsgRateLimitPolicyJson(
    await readFile(policyPath, "utf8"),
  );
  const bindings = buildMsgWranglerRateLimits(policy);
  const runtimeBindings = buildMsgMiniflareRateLimits(policy);

  if (bindings.length !== expectedBindings.length)
    throw new Error(
      `Expected ${expectedBindings.length} rate-limit bindings, received ${bindings.length}.`,
    );
  for (const [index, expected] of expectedBindings.entries()) {
    const binding = bindings[index];
    const runtimeBinding = runtimeBindings[expected.name];
    if (
      binding?.name !== expected.name ||
      binding?.simple.limit !== expected.limit ||
      binding?.simple.period !== 60 ||
      runtimeBinding?.simple.limit !== expected.limit ||
      runtimeBinding?.simple.period !== 60 ||
      runtimeBinding?.namespace_id !== binding?.namespace_id
    ) {
      throw new Error(`Unexpected ${expected.name} binding output.`);
    }
  }

  for (const binding of bindings)
    console.log(
      `${binding.name} limit=${binding.simple.limit} period=${binding.simple.period}`,
    );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
