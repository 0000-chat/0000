#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  machineMcpCredentialsDirectory,
  parseHostedMcpConnectorArgs,
  readMachineMcpCredential,
} from "./machine-mcp";

const DEFAULT_HOSTED_MCP_ENDPOINT = "https://api.0000.chat/mcp";

export function resolveHostedMcpConnectorConfig(input: {
  argv: string[];
  endpoint?: string;
  homeDirectory?: string;
}): { credentialsDirectory: string; endpoint: string; targetId: string } {
  const { targetId } = parseHostedMcpConnectorArgs(input.argv);
  const endpoint = input.endpoint ?? DEFAULT_HOSTED_MCP_ENDPOINT;
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("machine MCP endpoint must use HTTPS");
  }
  return {
    credentialsDirectory: machineMcpCredentialsDirectory(
      join(input.homeDirectory ?? homedir(), ".0000", "bridge.json"),
    ),
    endpoint: url.toString(),
    targetId,
  };
}

export async function startHostedMcpConnector(input: {
  argv: string[];
  endpoint?: string;
  homeDirectory?: string;
}): Promise<void> {
  const config = resolveHostedMcpConnectorConfig(input);
  const localCredential = await readMachineMcpCredential({
    credentialsDirectory: config.credentialsDirectory,
    targetId: config.targetId,
  });
  const remoteClient = new Client({
    name: "0000-machine-mcp-connector",
    version: "1.0.0",
  });
  const remoteTransport = new StreamableHTTPClientTransport(
    new URL(config.endpoint),
    {
      requestInit: {
        headers: { authorization: `Bearer ${localCredential.credential}` },
      },
    },
  );
  await remoteClient.connect(remoteTransport);
  const remoteTools = await remoteClient.listTools();

  const localServer = new Server(
    { name: "0000", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  localServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: remoteTools.tools,
  }));
  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await remoteClient.callTool(request.params);
  });
  await localServer.connect(new StdioServerTransport());
}

if (import.meta.main) {
  void startHostedMcpConnector({
    argv: process.argv.slice(2),
    endpoint: process.env.ZERO_CHAT_HOSTED_MCP_ENDPOINT,
  }).catch(() => {
    process.stderr.write("0000 MCP connector could not start.\n");
    process.exitCode = 1;
  });
}
