import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const pluginRoot = join(import.meta.dir, "..", "plugins", "msg");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

describe("msg portable plugin package", () => {
  test("contains the portable and compatibility manifests", () => {
    expect(existsSync(join(pluginRoot, "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginRoot, "mcp.json"))).toBe(true);
    expect(existsSync(join(pluginRoot, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  test("points the portable MCP server at the public stateless endpoint", () => {
    const manifest = readJson("mcp.json");
    const servers = manifest.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.msg).toMatchObject({
      type: "streamable-http",
      url: "https://msg.0000.chat/mcp",
    });
  });

  test("keeps the compatibility manifest aligned with the portable package", () => {
    const portable = readJson("plugin.json");
    const compatibility = readJson(".codex-plugin/plugin.json");
    expect(compatibility.name).toBe(portable.name);
    expect(compatibility.version).toBe(portable.version);
    const servers = compatibility.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.msg?.url).toBe("https://msg.0000.chat/mcp");
  });
});
