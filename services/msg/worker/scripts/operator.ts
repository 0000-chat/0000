export type OperatorCommand =
  | { readonly kind: "diagnostics" | "status" }
  | { readonly kind: "reports"; readonly limit?: number }
  | { readonly id: string; readonly kind: "report" }
  | { readonly id: string; readonly kind: "update-report"; readonly status: "closed" | "open" | "reviewed" }
  | { readonly kind: "delete"; readonly room: string };
const productionOrigin = "https://msg.0000.chat";

export function parseOperatorCommand(args: readonly string[]): OperatorCommand {
  const [command, ...rest] = args;
  if (command === "status" || command === "diagnostics") {
    if (rest.length !== 0) throw new Error("Unknown argument.");
    return { kind: command };
  }
  if (command === "reports") {
    if (rest.length === 0) return { kind: "reports" };
    if (rest.length === 2 && rest[0] === "--limit" && /^[1-9][0-9]*$/u.test(rest[1]) && Number(rest[1]) <= 100) return { kind: "reports", limit: Number(rest[1]) };
    throw new Error("Unknown argument.");
  }
  if (command === "report" && rest.length === 1) return { id: validateId(rest[0]), kind: "report" };
  if (command === "update-report" && rest.length === 2 && isReportStatus(rest[1])) return { id: validateId(rest[0]), kind: "update-report", status: rest[1] };
  if (command === "delete") {
    if (rest.length !== 2 || rest[1] !== "--yes") throw new Error("Forced deletion requires --yes.");
    return { kind: "delete", room: validateId(rest[0]) };
  }
  throw new Error("Unknown command.");
}

async function main(): Promise<void> {
  const credential = process.env.MSG_PLATFORM_OPERATOR_CREDENTIAL;
  if (!credential) throw new Error("MSG_PLATFORM_OPERATOR_CREDENTIAL is required in the environment.");
  const command = parseOperatorCommand(process.argv.slice(2));
  const base = operatorBase(productionOrigin);
  const response = await fetch(buildRequest(base, command, credential));
  const body = await response.text();
  if (!response.ok) throw new Error(`Operator request failed with status ${response.status}.`);
  process.stdout.write(`${body}\n`);
}

function buildRequest(base: URL, command: OperatorCommand, credential: string): Request {
  const headers = { authorization: `Bearer ${credential}` };
  if (command.kind === "status" || command.kind === "diagnostics") return new Request(new URL(`/operator/v1/${command.kind}`, base), { headers });
  if (command.kind === "reports") {
    const url = new URL("/operator/v1/reports", base);
    if (command.limit !== undefined) url.searchParams.set("limit", String(command.limit));
    return new Request(url, { headers });
  }
  if (command.kind === "report") return new Request(new URL(`/operator/v1/reports/${command.id}`, base), { headers });
  if (command.kind === "update-report") return new Request(new URL(`/operator/v1/reports/${command.id}`, base), { body: JSON.stringify({ status: command.status }), headers: { ...headers, "content-type": "application/json" }, method: "PATCH" });
  return new Request(new URL(`/operator/v1/rooms/${command.room}`, base), { headers, method: "DELETE" });
}

export function operatorBase(value: string): URL {
  const url = new URL(value);
  if (url.origin !== productionOrigin || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("The operator origin is not allowed.");
  return url;
}

function isReportStatus(value: string): value is "closed" | "open" | "reviewed" {
  return value === "closed" || value === "open" || value === "reviewed";
}

function validateId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("The target identifier is invalid.");
  return value;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Operator command failed."}\n`);
    process.exitCode = 1;
  });
}
