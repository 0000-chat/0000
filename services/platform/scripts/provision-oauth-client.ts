import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import {
  prepareTrustedOAuthClientRegistration,
  trustedOAuthClientStatements,
  type TrustedOAuthClientInput,
  type OAuthClientPurpose,
} from "../src/oauth-installation";

const databaseName = "platform-identity";

function sql(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

function parse(argv: string[]): {
  remote: boolean;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  let remote = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      remote = true;
      continue;
    }
    if (!arg?.startsWith("--")) {
      throw new Error(
        "Usage: bun scripts/provision-oauth-client.ts [--remote] --service-id ID --redirect-uri URI --capability NAME [--capability NAME] [--purpose personal_harness|first_party_browser] [--public|--confidential] [--refresh] [--owner-user-id ID]",
      );
    }
    const key = arg.slice(2);
    if (key === "public" || key === "confidential") {
      values.set(
        "auth-method",
        key === "public" ? "none" : "client_secret_post",
      );
      continue;
    }
    if (key === "refresh") {
      values.set("refresh", "true");
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing --${key}.`);
    if (key === "capability") {
      values.set(
        "capabilities",
        `${values.get("capabilities") ?? ""}${values.has("capabilities") ? "," : ""}${value}`,
      );
    } else {
      values.set(key, value);
    }
  }
  return { remote, values };
}

async function wrangler(sqlText: string, remote: boolean): Promise<string> {
  const file = `/tmp/0000-platform-oauth-${crypto.randomUUID()}.sql`;
  await Bun.write(file, sqlText);
  const child = spawn(
    "bun",
    [
      "x",
      "wrangler",
      "d1",
      "execute",
      databaseName,
      remote ? "--remote" : "--local",
      "--file",
      file,
      "--json",
    ],
    { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  let status: number;
  try {
    status = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    await unlink(file).catch(() => undefined);
  }
  if (status !== 0) {
    throw new Error(
      [stderr.trim(), stdout.trim(), "OAuth client provisioning failed."]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return stdout;
}

const { remote, values } = parse(process.argv.slice(2));
const serviceId = required(values, "service-id");
const redirectUri = required(values, "redirect-uri");
const capabilities = (values.get("capabilities") ?? "")
  .split(",")
  .map((capability) => capability.trim())
  .filter(Boolean);
if (capabilities.length === 0)
  throw new Error("Provide at least one --capability.");
const authMethod = values.get("auth-method") ?? "none";
if (authMethod !== "none" && authMethod !== "client_secret_post") {
  throw new Error("Choose --public or --confidential.");
}
const purpose = values.get("purpose") as OAuthClientPurpose | undefined;
if (
  purpose &&
  purpose !== "personal_harness" &&
  purpose !== "first_party_browser"
) {
  throw new Error(
    "Choose --purpose personal_harness or --purpose first_party_browser.",
  );
}
const secretKey = process.env.BETTER_AUTH_SECRET;
if (!secretKey)
  throw new Error(
    "BETTER_AUTH_SECRET must be supplied in the protected environment.",
  );

type WranglerResult = {
  results?: Array<Record<string, unknown>>;
};

function parseWranglerResults(output: string): WranglerResult[] {
  const start = output.indexOf("[");
  if (start < 0) throw new Error("D1 returned no machine-readable result.");
  try {
    return JSON.parse(output.slice(start)) as WranglerResult[];
  } catch {
    throw new Error("D1 returned an invalid machine-readable result.");
  }
}

const serviceOutput = await wrangler(
  `SELECT service_id, audience, allowed_capabilities
   FROM platform_service
   WHERE service_id = ${sql(serviceId)} AND disabled = 0;`,
  remote,
);
const serviceRow = parseWranglerResults(serviceOutput)
  .flatMap((result) => result.results ?? [])
  .at(-1);
if (
  !serviceRow ||
  typeof serviceRow.service_id !== "string" ||
  typeof serviceRow.audience !== "string" ||
  typeof serviceRow.allowed_capabilities !== "string"
) {
  throw new Error("service_not_found");
}
let catalog: unknown;
try {
  catalog = JSON.parse(serviceRow.allowed_capabilities);
} catch {
  throw new Error("service_catalog_malformed");
}
if (
  !Array.isArray(catalog) ||
  !catalog.every((value) => typeof value === "string")
) {
  throw new Error("service_catalog_malformed");
}
const input: TrustedOAuthClientInput = {
  serviceId,
  redirectUri,
  capabilities,
  authMethod,
  purpose,
  refreshEnabled: values.get("refresh") === "true",
  ownerUserId: values.get("owner-user-id") ?? null,
  name: values.get("name"),
};
const registration = await prepareTrustedOAuthClientRegistration(
  input,
  { serviceId: serviceRow.service_id, audience: serviceRow.audience, catalog },
  secretKey,
);
const renderedStatements = trustedOAuthClientStatements(registration).map(
  (statement) => {
    let index = 0;
    const rendered = statement.sql.replaceAll("?", () => {
      const value = statement.values[index++];
      if (index > statement.values.length)
        throw new Error("unbound SQL placeholder");
      return sql(value ?? null);
    });
    if (index !== statement.values.length) throw new Error("unused SQL value");
    return `${rendered};`;
  },
);
const result = await wrangler(
  `${renderedStatements.join("\n")}\nSELECT changes() AS changed;\n`,
  remote,
);
if (!/"changed"\s*:\s*1/.test(result))
  throw new Error("OAuth client registration did not complete.");
process.stdout.write(`registered ${registration.clientId}\n`);
if (registration.clientSecret)
  process.stdout.write(`client_secret=${registration.clientSecret}\n`);
