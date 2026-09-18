import { describe, expect, it, mock } from "bun:test";
import { createPlatformClient } from "./index";

const now = Date.now();
const validPrincipal = {
  version: 1,
  kind: "human",
  authority: "platform-deployment",
  subjectId: "user-1",
  credentialId: "credential-1",
  audience: "https://service.0000.test",
  capabilities: ["resource:read"],
  expiresAt: new Date(now + 60_000).toISOString(),
  organizationId: "org-1",
  membershipId: "member-1",
};

function client(fetch: typeof globalThis.fetch) {
  return createPlatformClient({
    baseUrl: "https://platform.test",
    authority: "platform-deployment",
    audience: "https://service.0000.test",
    serviceVerifier: "service-verifier-only",
    fetch,
  });
}

describe("Platform verification client", () => {
  it("sends the presented credential separately from the verifier and accepts a valid principal", async () => {
    let call: { url: URL; init: RequestInit } | undefined;
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      call = { url: new URL(String(input)), init: init ?? {} };
      return Response.json({ status: "authenticated", principal: validPrincipal });
    }) as unknown as typeof globalThis.fetch;

    const result = await client(fetch).authenticate("end-user-credential");
    expect(result.status).toBe("authenticated");
    expect(call?.url.pathname).toBe("/internal/v1/authenticate");
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer service-verifier-only");
    expect(JSON.parse(String(call?.init.body))).toEqual({ credential: "end-user-credential" });
  });

  it("treats a wrong authority or malformed success response as an authority failure", async () => {
    const wrongAuthority = client(async () => Response.json({
      status: "authenticated",
      principal: { ...validPrincipal, authority: "other-deployment" },
    })).authenticate("end-user-credential");
    const wrongAudience = client(async () => Response.json({
      status: "authenticated",
      principal: { ...validPrincipal, audience: "https://other-service.test" },
    })).authenticate("end-user-credential");
    const expired = client(async () => Response.json({
      status: "authenticated",
      principal: { ...validPrincipal, expiresAt: new Date(now - 1).toISOString() },
    })).authenticate("end-user-credential");
    const malformed = client(async () => Response.json({ status: "authenticated", principal: null }))
      .authenticate("end-user-credential");
    const unknownStatus = client(async () => Response.json({ status: "accepted", principal: validPrincipal }))
      .authenticate("end-user-credential");
    const malformedJson = client(async () => new Response("not-json", { status: 200 }))
      .authenticate("end-user-credential");
    const inconsistentHttpStatus = client(async () => Response.json({ status: "invalid_credential" }, { status: 200 }))
      .authenticate("end-user-credential");

    expect((await wrongAuthority).status).toBe("authority_unavailable");
    expect((await wrongAudience).status).toBe("authority_unavailable");
    expect((await expired).status).toBe("authority_unavailable");
    expect((await malformed).status).toBe("authority_unavailable");
    expect((await unknownStatus).status).toBe("authority_unavailable");
    expect((await malformedJson).status).toBe("authority_unavailable");
    expect((await inconsistentHttpStatus).status).toBe("authority_unavailable");
  });

  it("returns invalid only for a rejected presented credential, and fails closed on outage", async () => {
    let calls = 0;
    const rejected = await client(async () => {
      calls += 1;
      return Response.json({ status: "invalid_credential" }, { status: 401 });
    }).authenticate("end-user-credential");
    expect(rejected.status).toBe("invalid_credential");
    expect(calls).toBe(1);

    const verifierRejected = await client(async () => Response.json({ error: "service verifier rejected" }, { status: 401 }))
      .authenticate("end-user-credential");
    const wrongCategory = await client(async () => Response.json({ status: "authority_unavailable" }, { status: 401 }))
      .authenticate("end-user-credential");
    expect(verifierRejected.status).toBe("authority_unavailable");
    expect(wrongCategory.status).toBe("authority_unavailable");

    const outage = await client(async () => { throw new Error("offline"); })
      .authenticate("end-user-credential");
    expect(outage.status).toBe("authority_unavailable");
  });
});
