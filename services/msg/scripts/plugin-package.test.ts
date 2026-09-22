import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const pluginRoot = join(import.meta.dir, "..", "plugins", "msg");
const PORTABLE_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PORTABLE_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const MCP_ENDPOINT = "https://msg.0000.chat/mcp";
const WEBSITE_URL = "https://msg.0000.chat";
const PRIVACY_POLICY_URL = "https://msg.0000.chat/privacy";
const TERMS_OF_SERVICE_URL = "https://msg.0000.chat/terms";
const SUPPORT_URL = "https://github.com/0000-chat/0000/issues";

type JsonObject = Record<string, unknown>;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, path), "utf8")) as Record<string, unknown>;
}

function expectHttpsUrl(value: unknown): asserts value is string {
  expect(typeof value).toBe("string");
  expect(() => new URL(value as string)).not.toThrow();
  expect((value as string).startsWith("https://")).toBe(true);
}

function expectAssetPath(manifest: JsonObject, field: string): void {
  const value = manifest[field];
  expect(typeof value).toBe("string");
  expect((value as string).startsWith("./assets/")).toBe(true);
  expect((value as string).includes("..")).toBe(false);
  const assetPath = join(pluginRoot, value as string);
  expect(existsSync(assetPath)).toBe(true);
  expect(statSync(assetPath).isFile()).toBe(true);
}

function expectPortableManifestSchema(manifest: JsonObject): void {
  expect(manifest.$schema).toBe(PORTABLE_PLUGIN_SCHEMA);
  expect(Object.keys(manifest).every((key) => [
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ].includes(key))).toBe(true);
  expect(typeof manifest.name).toBe("string");
  expect((manifest.name as string).length).toBeGreaterThanOrEqual(1);
  expect((manifest.name as string).length).toBeLessThanOrEqual(64);
  expect(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name as string)).toBe(true);

  for (const field of ["version", "description", "homepage", "repository", "license"]) {
    if (manifest[field] !== undefined) expect(typeof manifest[field]).toBe("string");
  }
  if (manifest.author !== undefined) {
    expect(manifest.author).toBeObject();
    const author = manifest.author as JsonObject;
    expect(Object.keys(author).every((key) => ["name", "email", "url"].includes(key))).toBe(true);
    for (const field of ["name", "email", "url"]) {
      if (author[field] !== undefined) expect(typeof author[field]).toBe("string");
    }
  }
  if (manifest.keywords !== undefined) {
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect((manifest.keywords as unknown[]).every((keyword) => typeof keyword === "string")).toBe(true);
  }
  expect(manifest.extensions).toBeObject();
  for (const extension of Object.values(manifest.extensions as JsonObject)) {
    expect(extension).toBeObject();
  }
  expect((manifest.extensions as JsonObject)["com.openai"]).toBeObject();
}

function expectInterfaceMetadata(interfaceManifest: JsonObject): void {
  expect(interfaceManifest).toMatchObject({
    websiteURL: WEBSITE_URL,
    privacyPolicyURL: PRIVACY_POLICY_URL,
    termsOfServiceURL: TERMS_OF_SERVICE_URL,
    supportURL: SUPPORT_URL,
  });
  for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL", "supportURL"]) {
    expectHttpsUrl(interfaceManifest[field]);
  }
  for (const field of ["composerIcon", "logo", "logoDark"]) {
    expectAssetPath(interfaceManifest, field);
  }
}

describe("msg portable plugin package", () => {
  test("contains the portable and compatibility manifests", () => {
    expect(existsSync(join(pluginRoot, "plugin.json"))).toBe(true);
    expect(existsSync(join(pluginRoot, "mcp.json"))).toBe(true);
    expect(existsSync(join(pluginRoot, ".codex-plugin", "plugin.json"))).toBe(true);
  });

  test("conforms to the official portable manifest schema shape", () => {
    expectPortableManifestSchema(readJson("plugin.json"));
  });

  test("publishes complete OpenAI interface metadata in both manifests", () => {
    const portable = readJson("plugin.json");
    const openAi = (portable.extensions as JsonObject)["com.openai"] as JsonObject;
    const compatibility = readJson(".codex-plugin/plugin.json");
    expectInterfaceMetadata(openAi.interface as JsonObject);
    expectInterfaceMetadata(compatibility.interface as JsonObject);
  });

  test("points the portable MCP server at the public stateless endpoint", () => {
    const manifest = readJson("mcp.json");
    expect(manifest.$schema).toBe(PORTABLE_MCP_SCHEMA);
    expect(Object.keys(manifest)).toEqual(["$schema", "mcpServers"]);
    expect(manifest.mcpServers).toBeObject();
    const servers = manifest.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(["msg"]);
    expect(Object.keys(servers.msg)).toEqual(["type", "url"]);
    expect(servers.msg).toMatchObject({
      type: "streamable-http",
      url: MCP_ENDPOINT,
    });
    expectHttpsUrl(servers.msg.url);
  });

  test("keeps the compatibility manifest aligned with the portable package", () => {
    const portable = readJson("plugin.json");
    const compatibility = readJson(".codex-plugin/plugin.json");
    expect(compatibility.name).toBe(portable.name);
    expect(compatibility.version).toBe(portable.version);
    const servers = compatibility.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.msg?.type).toBe("streamable-http");
    expect(servers.msg?.url).toBe(MCP_ENDPOINT);
    expectHttpsUrl(servers.msg?.url);

    const portableInterface = ((portable.extensions as JsonObject)["com.openai"] as JsonObject).interface;
    expect(compatibility.interface).toEqual(portableInterface);
  });
});
