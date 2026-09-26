import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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

  const callGatewayInfo = async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://gateway.0000.chat/mcp"),
      {
        fetch: (input, init) => {
          const requestUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          return runtime.dispatchFetch(requestUrl, init);
        },
      },
    );
    const client = new Client({
      name: "gateway-runtime-test",
      version: "0.0.0",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map(({ name }) => name),
        ["gateway_info"],
      );

      const result = await client.callTool({
        name: "gateway_info",
        arguments: {},
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(result.content, [
        { type: "text", text: '{"status":"ok","service":"gateway"}' },
      ]);
    } finally {
      await client.close();
    }
  };

  await callGatewayInfo();
  await callGatewayInfo();
} finally {
  await runtime.dispose();
}
