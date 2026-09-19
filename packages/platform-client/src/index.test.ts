import { describe, expect, it, mock } from "bun:test";
import { createPlatformClient, createPlatformGuestClient } from "./index";

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
      return Response.json({
        status: "authenticated",
        principal: validPrincipal,
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await client(fetch).authenticate("end-user-credential");
    expect(result.status).toBe("authenticated");
    expect(call?.url.pathname).toBe("/internal/v1/authenticate");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      "Bearer service-verifier-only",
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      credential: "end-user-credential",
    });
  });

  it("treats a wrong authority or malformed success response as an authority failure", async () => {
    const wrongAuthority = client(async () =>
      Response.json({
        status: "authenticated",
        principal: { ...validPrincipal, authority: "other-deployment" },
      }),
    ).authenticate("end-user-credential");
    const wrongAudience = client(async () =>
      Response.json({
        status: "authenticated",
        principal: {
          ...validPrincipal,
          audience: "https://other-service.test",
        },
      }),
    ).authenticate("end-user-credential");
    const expired = client(async () =>
      Response.json({
        status: "authenticated",
        principal: {
          ...validPrincipal,
          expiresAt: new Date(now - 1).toISOString(),
        },
      }),
    ).authenticate("end-user-credential");
    const malformed = client(async () =>
      Response.json({ status: "authenticated", principal: null }),
    ).authenticate("end-user-credential");
    const unknownStatus = client(async () =>
      Response.json({ status: "accepted", principal: validPrincipal }),
    ).authenticate("end-user-credential");
    const malformedJson = client(
      async () => new Response("not-json", { status: 200 }),
    ).authenticate("end-user-credential");
    const inconsistentHttpStatus = client(async () =>
      Response.json({ status: "invalid_credential" }, { status: 200 }),
    ).authenticate("end-user-credential");

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

    const verifierRejected = await client(async () =>
      Response.json({ error: "service verifier rejected" }, { status: 401 }),
    ).authenticate("end-user-credential");
    const wrongCategory = await client(async () =>
      Response.json({ status: "authority_unavailable" }, { status: 401 }),
    ).authenticate("end-user-credential");
    expect(verifierRejected.status).toBe("authority_unavailable");
    expect(wrongCategory.status).toBe("authority_unavailable");

    const outage = await client(async () => {
      throw new Error("offline");
    }).authenticate("end-user-credential");
    expect(outage.status).toBe("authority_unavailable");
  });
});

describe("Platform guest control client", () => {
  const guestOptions = {
    baseUrl: "https://platform.test",
    authority: "platform-deployment",
    audience: "https://service.0000.test",
    guestGrantIssuer: "guest-issuer-only",
  };
  const guestPrincipal = {
    version: 1,
    kind: "guest",
    authority: "platform-deployment",
    subjectId: "guest-1",
    credentialId: "credential-1",
    audience: "https://service.0000.test",
    capabilities: ["resource:read"],
    expiresAt: null,
    grantId: "grant-1",
    resourceIds: ["resource-1"],
  };

  it("uses the issuer-only transport and validates a grant success", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname === "/internal/v1/guests") {
        return Response.json(
          {
            status: "success",
            guestId: "guest-1",
            bootstrapCredential: "bootstrap-1",
            authority: "platform-deployment",
            audience: "https://service.0000.test",
            purpose: "guest_control",
          },
          { status: 201 },
        );
      }
      return Response.json(
        {
          status: "success",
          credential: "grant-secret",
          credentialId: "credential-1",
          grantId: "grant-1",
          principal: guestPrincipal,
        },
        { status: 201 },
      );
    }) as unknown as typeof globalThis.fetch;
    const client = createPlatformGuestClient({ ...guestOptions, fetch });
    const created = await client.createGuest();
    const grant = await client.attestGuestGrant({
      bootstrapCredential: "bootstrap-1",
      resourceId: "resource-1",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: "guest-1" },
    });
    expect(created.status).toBe("success");
    expect(grant.status).toBe("success");
    expect(
      calls.every((call) => call.authorization === "Bearer guest-issuer-only"),
    ).toBe(true);
    expect(calls.map((call) => call.path)).toEqual([
      "/internal/v1/guests",
      "/internal/v1/guest-grants",
    ]);
  });

  it("preserves denial categories and fails closed on malformed or mismatched responses", async () => {
    const result = async (response: Response) =>
      createPlatformGuestClient({
        ...guestOptions,
        fetch: async () => response,
      }).resolveGuestControl("bootstrap-1");
    expect(
      (
        await result(
          Response.json({ status: "invalid_guest_control" }, { status: 401 }),
        )
      ).status,
    ).toBe("invalid_guest_control");
    expect(
      (await result(Response.json({ status: "grant_denied" }, { status: 403 })))
        .status,
    ).toBe("grant_denied");
    expect(
      (
        await result(
          Response.json({ status: "invalid_guest_control" }, { status: 200 }),
        )
      ).status,
    ).toBe("authority_unavailable");
    expect(
      (
        await result(
          Response.json({
            status: "success",
            guestId: "g",
            authority: "wrong",
            audience: guestOptions.audience,
            purpose: "guest_control",
          }),
        )
      ).status,
    ).toBe("authority_unavailable");
    expect(
      (await result(new Response("not-json", { status: 200 }))).status,
    ).toBe("authority_unavailable");
  });
});
