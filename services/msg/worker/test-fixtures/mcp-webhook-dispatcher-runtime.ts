import { createMcpWebhookDispatcherClient } from "../src/mcp-webhook-dispatcher-client";

interface DispatcherEnvironment {
  readonly MSG_MCP_WEBHOOK_DISPATCH_URL: string;
  readonly MSG_MCP_WEBHOOK_DISPATCH_TOKEN: string;
}

export default {
  async fetch(request: Request, env: DispatcherEnvironment): Promise<Response> {
    const callback = createMcpWebhookDispatcherClient({
      endpoint: env.MSG_MCP_WEBHOOK_DISPATCH_URL,
      token: env.MSG_MCP_WEBHOOK_DISPATCH_TOKEN,
    });
    return callback("https://callback.example.test/events", {
      body: await request.arrayBuffer(),
      headers: request.headers,
      method: "POST",
      redirect: "error",
    });
  },
};
