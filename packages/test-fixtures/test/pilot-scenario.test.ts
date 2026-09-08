import { describe, expect, it } from "vitest";
import {
  PilotIngestionDirectorySchema,
  PilotScenarioSchema,
  pilotIngestionDirectory,
  pilotScenario,
} from "../src/pilot-scenario";

describe("pilotScenario", () => {
  it("is contract-valid and identity-isolated", () => {
    const scenario = PilotScenarioSchema.parse(pilotScenario);
    const human = scenario.conversations.filter(
      (item) => item.identity_id === "identity_human",
    );
    const agent = scenario.conversations.filter(
      (item) => item.identity_id === "identity_agent",
    );
    expect(human.length).toBeGreaterThan(0);
    expect(agent.length).toBeGreaterThan(0);
    expect(human.some(
      (humanItem) => agent.some((agentItem) => agentItem.id === humanItem.id),
    )).toBe(false);
  });

  it("contains no real infrastructure or credential markers", () => {
    const serialized = JSON.stringify(pilotScenario);
    for (const forbidden of [
      "169.58.160.23",
      "communicator.0000.gold",
      "m.login",
      "access_token",
      "cookie",
      "@human:",
      "@agent:",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("gives Human three channels and Agent only Agent WhatsApp", () => {
    const human = pilotScenario.connections.filter((item) => item.identity_id === "identity_human");
    const agent = pilotScenario.connections.filter((item) => item.identity_id === "identity_agent");

    expect(human.map((item) => item.display_label)).toEqual([
      "Personal WhatsApp",
      "Telegram",
      "Messenger",
    ]);
    expect(agent.map((item) => item.display_label)).toEqual(["Agent WhatsApp"]);
  });

  it("has multiple conversations per Human channel and keeps same-name contacts separate", () => {
    const human = pilotScenario.conversations.filter((item) => item.identity_id === "identity_human");
    const counts = new Map<string, number>();
    for (const conversation of human) {
      counts.set(conversation.connection_id, (counts.get(conversation.connection_id) ?? 0) + 1);
    }

    expect(counts).toEqual(new Map([
      ["connection_human_whatsapp", 2],
      ["connection_human_telegram", 2],
      ["connection_human_messenger", 2],
    ]));
    expect(human.filter((item) => item.title === "Alex Rivera")).toHaveLength(2);
    expect(new Set(human.filter((item) => item.title === "Alex Rivera").map((item) => item.connection_id)).size).toBe(2);
  });

  it("contains timestamps and unread counts that prove global ordering", () => {
    const ordered = pilotScenario.conversations
      .filter((item) => item.identity_id === "identity_human")
      .toSorted((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.id.localeCompare(b.id));

    expect(ordered.map((item) => item.id)).toEqual([
      "conversation_human_telegram_alex",
      "conversation_human_whatsapp_family",
      "conversation_human_messenger_studio",
      "conversation_human_whatsapp_alex",
      "conversation_human_telegram_product",
      "conversation_human_messenger_archive",
    ]);
    expect(ordered.reduce((sum, item) => sum + item.unread_count, 0)).toBe(10);
  });

  it("contains two tenants, two service routes, and isolated Human/Agent channel bindings", () => {
    const directory = PilotIngestionDirectorySchema.parse(pilotIngestionDirectory);
    expect(directory.tenant_ids).toEqual(["tenant_pilot", "tenant_secondary"]);
    expect(directory.routes.map((route) => route.gateway_route_id)).toEqual([
      "gateway_route_human",
      "gateway_route_agent",
    ]);
    expect(new Set(directory.bindings.map((binding) => binding.tenant_id))).toEqual(
      new Set(directory.tenant_ids),
    );
    expect(new Set(directory.bindings.map((binding) => binding.platform))).toEqual(
      new Set(["whatsapp", "telegram", "messenger"]),
    );
    expect(directory.bindings.filter((binding) => binding.identity_id === "identity_human")
      .map((binding) => binding.platform)).toEqual(["messenger", "telegram", "whatsapp"]);
    expect(directory.bindings.filter((binding) => binding.identity_id === "identity_agent")
      .map((binding) => binding.platform)).toEqual(["whatsapp"]);
    expect(directory.bindings.every((binding) =>
      binding.account_status === "active" && binding.account_id.startsWith("account_"),
    )).toBe(true);
  });

  it("keeps routing fixtures non-secret and immutable to callers", () => {
    expect(Object.isFrozen(pilotIngestionDirectory)).toBe(true);
    expect(JSON.stringify(pilotIngestionDirectory).toLowerCase()).not.toMatch(
      /access_token|cookie|secret|password|matrix_.*token/,
    );
  });
});
