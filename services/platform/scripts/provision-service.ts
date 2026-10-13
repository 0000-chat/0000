import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  guestIssuerDisableSql,
  guestIssuerRegistrationSql,
  guestIssuerRotationSql,
  serviceDisableSql,
  serviceMetadataUpdateSql,
  serviceRegistrationSql,
  serviceVerifierRotationSql,
  ServiceRegistrationError,
  type ServiceRegistrationInput,
} from "../src/service-registration";
import {
  hashOpaque,
  opaqueSecret,
  validCapabilities,
  validServiceId,
} from "../src/platform-state";

const platformRoot = fileURLToPath(new URL("../", import.meta.url));
const databaseName = "platform-identity";

type Arguments = {
  operation:
    | "register"
    | "update"
    | "rotate-verifier"
    | "disable"
    | "register-guest-issuer"
    | "rotate-guest-issuer"
    | "disable-guest-issuer";
  values: Map<string, string[]>;
  remote: boolean;
  configPath?: string;
  wranglerPath?: string;
};

function usage(): never {
  throw new Error(
    "Usage: bun scripts/provision-service.ts [--local|--remote] [--config PATH] [--wrangler PATH] <register|update|rotate-verifier|disable|register-guest-issuer|rotate-guest-issuer|disable-guest-issuer> --service-id ID [options]",
  );
}

function parseArguments(argv: string[]): Arguments {
  let operation: Arguments["operation"] | undefined;
  let local = false;
  let remote = false;
  let configPath: string | undefined;
  let wranglerPath: string | undefined;
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local") {
      local = true;
      continue;
    }
    if (arg === "--remote") {
      remote = true;
      continue;
    }
    if (arg === "--config" || arg === "--wrangler") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage();
      if (arg === "--config") configPath = value;
      else wranglerPath = value;
      index += 1;
      continue;
    }
    if (!arg) continue;
    if (
      arg === "register" ||
      arg === "update" ||
      arg === "rotate-verifier" ||
      arg === "disable" ||
      arg === "register-guest-issuer" ||
      arg === "rotate-guest-issuer" ||
      arg === "disable-guest-issuer"
    ) {
      if (operation) usage();
      operation = arg;
      continue;
    }
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    index += 1;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  if (!operation) usage();
  if (local && remote) {
    throw new Error(
      "Choose exactly one provisioning target: --local or --remote.",
    );
  }
  return { operation, values, remote, configPath, wranglerPath };
}

function one(args: Arguments, name: string): string | undefined {
  return args.values.get(name)?.at(-1);
}

function required(args: Arguments, name: string): string {
  const value = one(args, name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function capabilities(args: Arguments): string[] {
  const values = args.values.get("capability") ?? [];
  const commaSeparated =
    one(args, "capabilities")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const result = [...values, ...commaSeparated];
  if (!validCapabilities(result)) {
    throw new Error("Provide one or more unique --capability values.");
  }
  return result;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseConfig(source: string): unknown {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (inString) {
      withoutComments += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      withoutComments += character;
      continue;
    }
    if (character === "/" && next === "/") {
      withoutComments += "  ";
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n" && source[index + 1] !== "\r") {
        withoutComments += " ";
        index += 1;
      }
      continue;
    }
    withoutComments += character;
  }
  const parsed: unknown = JSON.parse(withoutComments.replace(/,\s*([}\]])/gu, "$1"));
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuredDatabaseName(configPath: string | undefined): string {
  if (!configPath) return databaseName;
  let source = readFileSync(path.resolve(configPath), "utf8");
  const config = parseConfig(source);
  if (!isRecord(config)) {
    throw new Error("Wrangler config must contain an object.");
  }
  const databases = config.d1_databases;
  if (!Array.isArray(databases)) {
    throw new Error("Wrangler config must define the IDENTITY_DB D1 binding.");
  }
  const database = databases.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.binding === "IDENTITY_DB",
  );
  const selectedName = database?.database_name;
  if (typeof selectedName !== "string" || selectedName.length === 0) {
    throw new Error("Wrangler config must define the IDENTITY_DB D1 binding.");
  }
  return selectedName;
}

async function runWrangler(sql: string, args: Arguments): Promise<string> {
  const scope = args.remote ? "--remote" : "--local";
  const configPath = args.configPath ? path.resolve(args.configPath) : undefined;
  const selectedDatabase = configuredDatabaseName(configPath);
  const command = args.wranglerPath ? args.wranglerPath : "bun";
  const commandArgs = args.wranglerPath
    ? ["d1", "execute", selectedDatabase, scope, "--command", sql, "--json"]
    : ["x", "wrangler", "d1", "execute", selectedDatabase, scope, "--command", sql, "--json"];
  if (configPath) commandArgs.push("--config", configPath);
  const cwd = configPath ? path.dirname(configPath) : platformRoot;
  const child = spawn(command, commandArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "D1 provisioning operation failed.");
  }
  return stdout;
}

type WranglerResult = {
  results?: Array<Record<string, unknown>>;
  meta?: { changes?: number };
};

function parseWranglerResults(output: string): WranglerResult[] {
  const match = output.match(/\[\s*\{\s*"results"\s*:/);
  if (!match || match.index === undefined) {
    throw new Error("D1 returned no machine-readable result.");
  }
  try {
    return JSON.parse(output.slice(match.index)) as WranglerResult[];
  } catch {
    throw new Error("D1 returned an invalid machine-readable result.");
  }
}

function assertChanged(output: string, operation: string): void {
  const results = parseWranglerResults(output);
  const changed = results.at(-1)?.results?.[0]?.changed;
  if (changed !== 1)
    throw new Error(`${operation} did not change a registered service.`);
}

function registerInput(args: Arguments): ServiceRegistrationInput {
  return {
    serviceId: required(args, "service-id"),
    audience: required(args, "audience"),
    capabilities: capabilities(args),
    displayName: one(args, "name"),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const serviceId = required(args, "service-id");
  if (!validServiceId(serviceId)) throw new Error("Invalid --service-id.");

  if (args.operation === "register") {
    const input = registerInput(args);
    const existing = parseWranglerResults(
      await runWrangler(
        `SELECT service_id FROM platform_service WHERE service_id = ${sqlString(input.serviceId)} OR audience = ${sqlString(input.audience)};`,
        args,
      ),
    ).at(-1)?.results;
    if (existing && existing.length > 0) {
      throw new Error(
        "service_conflict: service ID or audience is already registered; no verifier was rotated.",
      );
    }
    const verifier = opaqueSecret("service_verify_");
    await runWrangler(
      serviceRegistrationSql(input, await hashOpaque(verifier), Date.now()),
      args,
    );
    // This is the only successful operation that prints the new verifier.
    process.stdout.write(
      `registered ${input.serviceId}\nverifier=${verifier}\n`,
    );
    return;
  }

  if (args.operation === "update") {
    const nextCapabilities = capabilities(args);
    const name = one(args, "name");
    const output = await runWrangler(
      `${serviceMetadataUpdateSql(
        { serviceId, capabilities: nextCapabilities, displayName: name },
        Date.now(),
      )} SELECT changes() AS changed;`,
      args,
    );
    assertChanged(output, "update");
    process.stdout.write(`updated ${serviceId}\n`);
    return;
  }

  if (args.operation === "rotate-verifier") {
    const verifier = opaqueSecret("service_verify_");
    const output = await runWrangler(
      `${serviceVerifierRotationSql(
        serviceId,
        await hashOpaque(verifier),
        Date.now(),
      )} SELECT changes() AS changed;`,
      args,
    );
    assertChanged(output, "rotate-verifier");
    process.stdout.write(`rotated ${serviceId}\nverifier=${verifier}\n`);
    return;
  }

  if (args.operation === "register-guest-issuer") {
    const issuer = opaqueSecret("service_guest_grant_");
    const output = await runWrangler(
      `${guestIssuerRegistrationSql(
        serviceId,
        await hashOpaque(issuer),
        Date.now(),
      )} SELECT changes() AS changed;`,
      args,
    );
    assertChanged(output, "register-guest-issuer");
    process.stdout.write(
      `registered-guest-issuer ${serviceId}\nissuer=${issuer}\n`,
    );
    return;
  }

  if (args.operation === "rotate-guest-issuer") {
    const current = parseWranglerResults(
      await runWrangler(
        `SELECT service_id FROM platform_service WHERE service_id = ${sqlString(serviceId)} AND disabled = 0; SELECT credential_hash FROM platform_service_grant_issuer WHERE service_id = ${sqlString(serviceId)} AND disabled = 0;`,
        args,
      ),
    );
    if ((current.at(-2)?.results?.length ?? 0) === 0) {
      throw new Error(
        "rotate-guest-issuer: service registration was not found or is disabled.",
      );
    }
    if ((current.at(-1)?.results?.length ?? 0) === 0) {
      throw new Error(
        "rotate-guest-issuer: the service has no active guest issuer.",
      );
    }
    const priorIssuerHash = current.at(-1)?.results?.[0]?.credential_hash;
    if (typeof priorIssuerHash !== "string") {
      throw new Error(
        "rotate-guest-issuer: the active guest issuer hash was not returned.",
      );
    }
    const issuer = opaqueSecret("service_guest_grant_");
    const output = await runWrangler(
      `${guestIssuerRotationSql(
        serviceId,
        await hashOpaque(issuer),
        Date.now(),
        priorIssuerHash,
      )} SELECT changes() AS changed;`,
      args,
    );
    assertChanged(output, "rotate-guest-issuer");
    process.stdout.write(
      `rotated-guest-issuer ${serviceId}\nissuer=${issuer}\n`,
    );
    return;
  }

  if (args.operation === "disable-guest-issuer") {
    const output = await runWrangler(
      `${guestIssuerDisableSql(serviceId, Date.now())} SELECT changes() AS changed; SELECT service_id FROM platform_service WHERE service_id = ${sqlString(serviceId)};`,
      args,
    );
    const results = parseWranglerResults(output);
    if ((results.at(-1)?.results?.length ?? 0) === 0) {
      throw new Error(
        "disable-guest-issuer: service registration was not found.",
      );
    }
    const changed = results.at(-2)?.results?.[0]?.changed === 1;
    process.stdout.write(
      `${changed ? "disabled-guest-issuer" : "already-disabled-guest-issuer"} ${serviceId}\n`,
    );
    return;
  }

  const output = await runWrangler(
    `${serviceDisableSql(serviceId, Date.now())} SELECT changes() AS changed; SELECT service_id, disabled FROM platform_service WHERE service_id = ${sqlString(serviceId)};`,
    args,
  );
  const results = parseWranglerResults(output);
  const changed = results.at(-2)?.results?.[0]?.changed === 1;
  const rows = results.at(-1)?.results ?? [];
  const row = rows[0];
  if (!row) throw new Error("disable: service registration was not found.");
  if (row.disabled !== 1)
    throw new Error("disable: D1 did not disable the service.");
  process.stdout.write(
    `${changed ? "disabled" : "already-disabled"} ${serviceId}\n`,
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ServiceRegistrationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : "provisioning failed"}\n`,
    );
  }
  process.exitCode = 1;
}
