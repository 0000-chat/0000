import { describe, expect, it } from "vitest";
import { PilotScenarioSchema } from "../src/pilot-scenario";
import { pilotScenario } from "../src/pilot-scenario";

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
});
