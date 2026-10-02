import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Miniflare } from "miniflare";

const [workerPath, configPath, migrationPath] = process.argv.slice(2);
if (!workerPath || !configPath)
  throw new Error("Worker and config paths are required.");
const config = JSON.parse(await readFile(configPath, "utf8"));
const runtime = new Miniflare({
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  modules: true,
  script: await readFile(workerPath, "utf8"),
  d1Databases: { GATEWAY_DB: "gateway-authenticated-test" },
});
const database = await runtime.getD1Database("GATEWAY_DB");
for (const statement of (await readFile(migrationPath, "utf8"))
  .split(";")
  .map((part) => part.trim())
  .filter(Boolean)) {
  await database.prepare(statement).run();
}
const control = async (path, body) => {
  const response = await runtime.dispatchFetch(
    `https://gateway.0000.chat${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  assert.equal(response.status, 200);
};
for (const profile of [
  "org-a/profile-a",
  "org-a/profile-b",
  "org-b/profile-a",
]) {
  await control("/__test/profile", { profile });
}
await control("/__test/grants", {
  profile: "org-a/profile-a",
  operationIds: ["fixture.read"],
});
await control("/__test/grants", {
  profile: "org-a/profile-b",
  operationIds: ["fixture.write"],
});
await control("/__test/grants", {
  profile: "org-b/profile-a",
  operationIds: ["fixture.read"],
});

const dispatch = async (input, init) => {
  const isRequest =
    input &&
    typeof input === "object" &&
    typeof input.url === "string" &&
    input.headers;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const headers = new Headers(isRequest ? input.headers : undefined);
  for (const [name, value] of new Headers(init?.headers))
    headers.set(name, value);
  const requestInit = {
    ...init,
    method: init?.method ?? (isRequest ? input.method : undefined),
    headers,
  };
  if (
    requestInit.body === undefined &&
    isRequest &&
    !["GET", "HEAD"].includes(input.method) &&
    input.body !== null
  ) {
    requestInit.body = await input.clone().arrayBuffer();
  }
  return runtime.dispatchFetch(url, requestInit);
};
const makeClient = (token, path = "/mcp/profile/profile-a") => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`https://gateway.0000.chat${path}`),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: dispatch,
    },
  );
  return {
    client: new Client({
      name: "gateway-authenticated-test",
      version: "0.0.0",
    }),
    transport,
  };
};
const call = async (token, name, args, path) => {
  const { client, transport } = makeClient(token, path);
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
};
const list = async (token, path = "/mcp/profile/profile-a") => {
  const { client, transport } = makeClient(token, path);
  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close();
  }
};

const health = await runtime.dispatchFetch("https://gateway.0000.chat/health");
assert.equal(health.status, 200);
const tools = await list("agent-a");
assert.deepEqual(
  tools.tools.map(({ name }) => name),
  ["use", "tools.search", "fixture_read"],
);
assert.deepEqual(
  (await list("agent-b", "/mcp/profile/profile-b")).tools.map(
    ({ name }) => name,
  ),
  ["use", "tools.search", "fixture_write"],
);
assert.equal(
  (
    await runtime.dispatchFetch(
      "https://gateway.0000.chat/mcp/organizations/org-a/profiles/profile-a",
      {
        method: "POST",
        headers: {
          authorization: "Bearer outsider",
          "content-type": "application/json",
        },
        body: "{}",
      },
    )
  ).status,
  403,
);

const read = await call("agent-a", "fixture_read", { resourceId: "allowed" });
assert.notEqual(read.isError, true);
const deniedExact = await call("agent-a", "fixture_write", {
  resourceId: "allowed",
  value: "x",
});
assert.equal(deniedExact.isError, true);
const use = await call("agent-a", "use", {
  program: "return await tools.fixture_read({resourceId: 'allowed'});",
});
assert.notEqual(use.isError, true);
const dependent = await call("agent-a", "use", {
  program:
    "const value = await tools.fixture_read({resourceId: 'allowed'}); return {value: value.value};",
});
assert.notEqual(dependent.isError, true);
const blocked = await call("agent-a", "use", {
  program: "return await fetch('https://example.com');",
});
assert.equal(blocked.isError, true);
const downstreamDenied = await call("agent-a", "use", {
  program: "return await tools.fixture_read({resourceId: 'restricted'});",
});
assert.equal(downstreamDenied.isError, true);

await runtime.dispatchFetch("https://gateway.0000.chat/__test/grants", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ profile: "org-a/profile-a", operationIds: [] }),
});
const revoked = await call("agent-a", "fixture_read", {
  resourceId: "allowed",
});
assert.equal(revoked.isError, true);
const revokedThroughUse = await call("agent-a", "use", {
  program: "return await tools.fixture_read({resourceId: 'allowed'});",
});
assert.equal(revokedThroughUse.isError, true);

await runtime.dispose();
