import { describe, expect, it } from "bun:test";
import { parseAuthenticationResult, parsePrincipal } from "./index";

const expectations = {
  authority: "platform-test-deployment",
  audience: "https://resource.0000.test",
  now: Date.UTC(2026, 0, 1),
};

describe("versioned principal validation", () => {
  it("reconstructs a guest principal without injected organization authority", () => {
    const parsed = parsePrincipal(
      {
        version: 1,
        kind: "guest",
        authority: expectations.authority,
        subjectId: "guest-1",
        credentialId: "credential-1",
        audience: expectations.audience,
        capabilities: ["resource:read"],
        expiresAt: null,
        grantId: "grant-1",
        resourceIds: ["resource-1"],
        organizationId: "injected-org",
        membershipId: "injected-membership",
      },
      expectations,
    );

    expect(parsed?.kind).toBe("guest");
    expect(parsed && "organizationId" in parsed).toBe(false);
    expect(parsed && "membershipId" in parsed).toBe(false);
  });

  it("requires a current membership reference for human authority", () => {
    const principal = {
      version: 1,
      kind: "human",
      authority: expectations.authority,
      subjectId: "user-1",
      credentialId: "credential-1",
      audience: expectations.audience,
      capabilities: ["resource:read"],
      expiresAt: "2026-01-02T00:00:00.000Z",
      organizationId: "org-1",
    };
    expect(parsePrincipal(principal, expectations)).toBeNull();
  });

  it("keeps a successful wire principal unknown until kind-specific validation", () => {
    const rawPrincipal = { kind: "guest", organizationId: "attacker-value" };
    const parsed = parseAuthenticationResult({ status: "authenticated", principal: rawPrincipal });
    expect(parsed).toEqual({ status: "authenticated", principal: rawPrincipal });
    expect(parsed?.status === "authenticated" && parsed.principal).toBe(rawPrincipal);
  });
});
