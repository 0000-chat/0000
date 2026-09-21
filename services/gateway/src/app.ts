import { Hono } from "hono";
import { MCPServer } from "mcp-use";
import { z } from "zod";

const app = new Hono();

const mcpServer = new MCPServer({
  name: "0000-gateway",
  version: "0.0.0",
  basePath: "/mcp",
});

mcpServer.tool(
  {
    name: "gateway_info",
    description: "Return the Gateway service health status.",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => ({
    content: [{ type: "text", text: '{"status":"ok","service":"gateway"}' }],
  }),
);

app.get("/health", (context) =>
  context.json({ status: "ok", service: "gateway" }, 200),
);

app.mount("/", mcpServer.fetch);

export default app;
