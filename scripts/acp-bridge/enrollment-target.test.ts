import { expect, test } from "bun:test";

import { resolveEnrollmentAgentTarget } from "./enrollment-target";

test("uses the active named Hermes profile for Machine enrollment", () => {
  expect(
    resolveEnrollmentAgentTarget({
      agentCommand: "hermes acp",
      env: {
        HERMES_HOME: "/home/don/.hermes/profiles/rachel",
      },
    }),
  ).toEqual({
    agentCommand: "hermes --profile rachel acp",
    profileIdentity: "rachel",
  });
});

test("uses an explicitly requested Hermes profile when no active profile is known", () => {
  expect(
    resolveEnrollmentAgentTarget({
      agentCommand: "hermes acp",
      profileIdentity: "rachel",
    }),
  ).toEqual({
    agentCommand: "hermes --profile rachel acp",
    profileIdentity: "rachel",
  });
});

test("keeps a Hermes command with its own profile", () => {
  expect(
    resolveEnrollmentAgentTarget({
      agentCommand: "hermes --profile rachel acp",
      env: {
        HERMES_HOME: "/home/don/.hermes/profiles/default",
      },
    }),
  ).toEqual({
    agentCommand: "hermes --profile rachel acp",
    profileIdentity: "rachel",
  });
});
