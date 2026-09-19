import {
  createPlatformClient,
  createPlatformGuestClient,
} from "@0000/platform-client";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  disableGuestIssuer,
  disableService,
  registerGuestIssuer,
  rotateGuestIssuer,
} from "../../src/service-registration";
import {
  GuestAuthorityUnavailable,
  GuestGrantConflict,
  renewGuestGrant,
  revokeGuestGrant,
} from "../../src/guest-state";
import { hashOpaque, opaqueSecret } from "../../src/platform-state";
import {
  attestGuestResource,
  handleGuestBootstrapRequest,
  handleResourceRequest,
  type ResourceServiceConfig,
} from "./fixtures/resource-service";
import { registerTestService, type TestService } from "./fixtures/provision";

const testEnv = env as Cloudflare.Env;

function service(suffix: string, audience: string): TestService {
  return {
    serviceId: `t08-${suffix}-${crypto.randomUUID().slice(0, 8)}`,
    audience,
    verifier: opaqueSecret("service_verify_"),
    guestGrantIssuer: opaqueSecret("service_guest_grant_"),
    allowedCapabilities: ["resource:read"],
  };
}

function guestClient(service: TestService) {
  return createPlatformGuestClient({
    baseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    guestGrantIssuer: service.guestGrantIssuer,
    fetch: (input, init) => SELF.fetch(input, init),
  });
}

function resourceConfig(service: TestService): ResourceServiceConfig {
  return {
    database: testEnv.IDENTITY_DB,
    platformBaseUrl: testEnv.PLATFORM_BASE_URL,
    authority: testEnv.PLATFORM_AUTHORITY_ID,
    audience: service.audience,
    serviceId: service.serviceId,
    serviceVerifier: service.verifier,
    guestGrantIssuer: service.guestGrantIssuer,
    fetch: (input, init) => SELF.fetch(input, init),
  };
}

async function readResource(
  service: TestService,
  resourceId: string,
  credential: string,
) {
  return handleResourceRequest(
    new Request(`https://fixture.test/resources/${resourceId}`, {
      headers: { authorization: `Bearer ${credential}` },
    }),
    resourceConfig(service),
  );
}

describe("T08 persistent guest control and resource grants", () => {
  it("keeps guest control, ACL proof, renewal, rollback, and revocation service-scoped", async () => {
    const first = service("first", "https://t08-first.0000.test");
    const second = service("second", "https://t08-second.0000.test");
    await registerTestService(testEnv.IDENTITY_DB, first);
    await registerTestService(testEnv.IDENTITY_DB, second);
    expect(
      (
        await SELF.fetch("http://localhost/api/guest/bootstrap", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    const previousIssuer = first.guestGrantIssuer;
    first.guestGrantIssuer = (
      await rotateGuestIssuer(testEnv.IDENTITY_DB, first.serviceId)
    ).guestGrantIssuer;

    const firstClient = guestClient(first);
    const secondClient = guestClient(second);
    const guest = await firstClient.createGuest();
    const otherGuest = await firstClient.createGuest();
    expect(guest.status).toBe("success");
    expect(otherGuest.status).toBe("success");
    if (guest.status !== "success" || otherGuest.status !== "success") return;

    const resumed = await secondClient.resolveGuestControl(
      guest.bootstrapCredential,
    );
    expect(resumed).toMatchObject({
      status: "success",
      guestId: guest.guestId,
    });
    const wrongIssuer = createPlatformGuestClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: first.audience,
      guestGrantIssuer: first.verifier,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    expect((await wrongIssuer.createGuest()).status).toBe(
      "authority_unavailable",
    );
    const retiredIssuer = createPlatformGuestClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: first.audience,
      guestGrantIssuer: previousIssuer,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    expect((await retiredIssuer.createGuest()).status).toBe(
      "authority_unavailable",
    );
    expect(
      (await retiredIssuer.resolveGuestControl(guest.bootstrapCredential))
        .status,
    ).toBe("authority_unavailable");
    const wrongAudience = createPlatformGuestClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: second.audience,
      guestGrantIssuer: first.guestGrantIssuer,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    expect((await wrongAudience.createGuest()).status).toBe(
      "authority_unavailable",
    );

    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO fixture_resource
       (id, owner_kind, owner_id, created_at, audience)
       VALUES (?, 'guest', ?, ?, ?), (?, 'guest', ?, ?, ?), (?, 'guest', ?, ?, ?),
              (?, 'guest', ?, ?, ?)`,
    )
      .bind(
        "t08-owned",
        guest.guestId,
        Date.now(),
        first.audience,
        "t08-participant",
        guest.guestId,
        Date.now(),
        first.audience,
        "t08-second-service",
        guest.guestId,
        Date.now(),
        second.audience,
        "t08-owned-sibling",
        guest.guestId,
        Date.now(),
        first.audience,
      )
      .run();
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO fixture_resource_participant
       (resource_id, guest_id, service_id, audience, link_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "t08-participant",
        otherGuest.guestId,
        first.serviceId,
        first.audience,
        "t08-link",
        Date.now(),
      )
      .run();

    const ownerGrant = await attestGuestResource(resourceConfig(first), {
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-owned",
      capabilities: ["resource:read"],
    });
    expect(ownerGrant).toBeTruthy();
    const sameGuestSiblingGrant = await attestGuestResource(
      resourceConfig(first),
      {
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-owned-sibling",
        capabilities: ["resource:read"],
      },
    );
    expect(sameGuestSiblingGrant).toBeTruthy();
    const sibling = await secondClient.attestGuestGrant({
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-second-service",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    expect(sibling.status).toBe("success");
    expect(
      await attestGuestResource(resourceConfig(first), {
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-owned",
        capabilities: ["resource:admin"],
      }),
    ).toBeNull();
    expect(
      await firstClient.attestGuestGrant({
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-owned",
        capabilities: ["resource:admin"],
        assertion: { kind: "owner", storedOwnerId: guest.guestId },
      }),
    ).toMatchObject({ status: "grant_denied" });
    expect(
      await firstClient.attestGuestGrant({
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-owned",
        capabilities: ["resource:read"],
        assertion: { kind: "owner", storedOwnerId: otherGuest.guestId },
      }),
    ).toMatchObject({ status: "grant_denied" });
    const participantGrant = await attestGuestResource(resourceConfig(first), {
      bootstrapCredential: otherGuest.bootstrapCredential,
      resourceId: "t08-participant",
      capabilities: ["resource:read"],
      assertion: "participant",
      participantLink: "t08-link",
    });
    expect(participantGrant).toBeTruthy();
    expect(
      await attestGuestResource(resourceConfig(first), {
        bootstrapCredential: otherGuest.bootstrapCredential,
        resourceId: "t08-participant",
        capabilities: ["resource:read"],
        assertion: "participant",
        participantLink: "wrong-link",
      }),
    ).toBeNull();
    const ownerParticipantResourceGrant = await attestGuestResource(
      resourceConfig(first),
      {
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-participant",
        capabilities: ["resource:read"],
      },
    );
    expect(ownerParticipantResourceGrant).toBeTruthy();
    const transferredParticipant = await firstClient.createGuest();
    expect(transferredParticipant.status).toBe("success");
    if (
      !ownerGrant ||
      !sameGuestSiblingGrant ||
      sibling.status !== "success" ||
      !participantGrant ||
      !ownerParticipantResourceGrant ||
      transferredParticipant.status !== "success"
    )
      return;
    await testEnv.IDENTITY_DB.prepare(
      `INSERT INTO fixture_resource_participant
       (resource_id, guest_id, service_id, audience, link_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "t08-participant",
        transferredParticipant.guestId,
        first.serviceId,
        first.audience,
        "t08-transfer-link",
        Date.now(),
      )
      .run();
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE fixture_resource SET owner_kind = 'organization', owner_id = ? WHERE id = ?",
    )
      .bind("t08-transfer-org", "t08-participant")
      .run();
    expect(
      (
        await readResource(
          first,
          "t08-participant",
          ownerParticipantResourceGrant.credential,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readResource(
          first,
          "t08-participant",
          participantGrant.credential,
        )
      ).status,
    ).toBe(200);
    const transferredParticipantGrant = await attestGuestResource(
      resourceConfig(first),
      {
        bootstrapCredential: transferredParticipant.bootstrapCredential,
        resourceId: "t08-participant",
        capabilities: ["resource:read"],
        assertion: "participant",
        participantLink: "t08-transfer-link",
      },
    );
    expect(transferredParticipantGrant).toBeTruthy();
    if (!transferredParticipantGrant) return;
    expect(
      (
        await readResource(
          first,
          "t08-participant",
          transferredParticipantGrant.credential,
        )
      ).status,
    ).toBe(200);

    expect(ownerGrant).toBeTruthy();
    if (!ownerGrant) return;
    expect(
      (await readResource(first, "t08-owned", ownerGrant.credential)).status,
    ).toBe(200);
    const platform = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: first.audience,
      serviceVerifier: first.verifier,
      fetch: (input, init) => SELF.fetch(input, init),
    });
    const renewed = await firstClient.renewGuestGrant({
      grantId: ownerGrant.grantId,
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-owned",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    expect(renewed.status).toBe("success");
    if (renewed.status !== "success") return;
    expect(renewed.value.grantId).toBe(ownerGrant.grantId);
    expect(renewed.value.principal.subjectId).toBe(guest.guestId);
    expect((await platform.authenticate(ownerGrant.credential)).status).toBe(
      "invalid_credential",
    );
    expect((await platform.authenticate(renewed.value.credential)).status).toBe(
      "authenticated",
    );
    const lostResponse = await firstClient.renewGuestGrant({
      grantId: renewed.value.grantId,
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-owned",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    expect(lostResponse.status).toBe("success");
    const recoveredAfterLostResponse = await firstClient.renewGuestGrant({
      grantId: renewed.value.grantId,
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-owned",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    expect(recoveredAfterLostResponse.status).toBe("success");

    let releaseCurrentReads!: () => void;
    const currentReadsReleased = new Promise<void>((resolve) => {
      releaseCurrentReads = resolve;
    });
    let currentReads = 0;
    const delayedDatabase = new Proxy(testEnv.IDENTITY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("SELECT guest_grant.guest_id")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      return Reflect.get(
                        boundTarget,
                        boundProperty,
                        boundReceiver,
                      );
                    }
                    return async (...args: unknown[]) => {
                      const value = await (
                        boundTarget.first as (...values: unknown[]) => unknown
                      )(...args);
                      currentReads += 1;
                      if (currentReads === 2) releaseCurrentReads();
                      await currentReadsReleased;
                      return value;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as unknown as D1Database;
    const issuer = {
      service: {
        serviceId: first.serviceId,
        audience: first.audience,
        verifierHash: await hashOpaque(first.verifier),
        allowedCapabilities: first.allowedCapabilities,
      },
      issuerHash: await hashOpaque(first.guestGrantIssuer),
    };
    const directRenew = async () => {
      try {
        return await renewGuestGrant(delayedDatabase, {
          issuer,
          authority: testEnv.PLATFORM_AUTHORITY_ID,
          grantId: renewed.value.grantId,
          bootstrapCredential: guest.bootstrapCredential,
          resourceId: "t08-owned",
          capabilities: ["resource:read"],
          assertion: { kind: "owner", storedOwnerId: guest.guestId },
        });
      } catch (error) {
        if (error instanceof GuestGrantConflict)
          return { status: "conflict" as const };
        throw error;
      }
    };
    const directRace = await Promise.all([directRenew(), directRenew()]);
    /* The two reads are held at the same predecessor; the SQL CAS has one winner. */
    expect(directRace.map((result) => result.status).sort()).toEqual([
      "conflict",
      "success",
    ]);
    const current = directRace.find((result) => result.status === "success");
    if (!current || current.status !== "success") return;

    await testEnv.IDENTITY_DB.prepare(
      `CREATE TRIGGER t08_fail_guest_replacement
       BEFORE INSERT ON platform_credential
       WHEN NEW.predecessor_id IS NOT NULL
       BEGIN SELECT RAISE(ABORT, 't08 replacement insert failure'); END`,
    ).run();
    const rollback = await firstClient.renewGuestGrant({
      grantId: current.value.grantId,
      bootstrapCredential: guest.bootstrapCredential,
      resourceId: "t08-owned",
      capabilities: ["resource:read"],
      assertion: { kind: "owner", storedOwnerId: guest.guestId },
    });
    let replacementFailure: unknown;
    try {
      await renewGuestGrant(testEnv.IDENTITY_DB, {
        issuer,
        authority: testEnv.PLATFORM_AUTHORITY_ID,
        grantId: current.value.grantId,
        bootstrapCredential: guest.bootstrapCredential,
        resourceId: "t08-owned",
        capabilities: ["resource:read"],
        assertion: { kind: "owner", storedOwnerId: guest.guestId },
      });
    } catch (error) {
      replacementFailure = error;
    }
    expect(replacementFailure).toBeInstanceOf(Error);
    expect((replacementFailure as Error).message).toContain(
      "t08 replacement insert failure",
    );
    await testEnv.IDENTITY_DB.prepare(
      "DROP TRIGGER t08_fail_guest_replacement",
    ).run();
    expect(rollback.status).toBe("authority_unavailable");
    expect((await platform.authenticate(current.value.credential)).status).toBe(
      "authenticated",
    );

    let releaseRevokeLookup!: () => void;
    const revokeLookupReleased = new Promise<void>((resolve) => {
      releaseRevokeLookup = resolve;
    });
    let revokeLookupStarted!: () => void;
    const revokeLookupObserved = new Promise<void>((resolve) => {
      revokeLookupStarted = resolve;
    });
    const delayedRevokeDatabase = new Proxy(testEnv.IDENTITY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("SELECT id FROM platform_guest_grant"))
            return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      return Reflect.get(
                        boundTarget,
                        boundProperty,
                        boundReceiver,
                      );
                    }
                    return async (...args: unknown[]) => {
                      const value = await (
                        boundTarget.first as (...values: unknown[]) => unknown
                      )(...args);
                      revokeLookupStarted();
                      await revokeLookupReleased;
                      return value;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as unknown as D1Database;
    const staleIssuer = { ...issuer };
    const staleRevoke = revokeGuestGrant(delayedRevokeDatabase, {
      issuer: staleIssuer,
      grantId: current.value.grantId,
    });
    await revokeLookupObserved;
    const rotatedIssuer = await rotateGuestIssuer(
      testEnv.IDENTITY_DB,
      first.serviceId,
    );
    releaseRevokeLookup();
    await expect(staleRevoke).rejects.toBeInstanceOf(GuestAuthorityUnavailable);
    expect((await platform.authenticate(current.value.credential)).status).toBe(
      "authenticated",
    );
    first.guestGrantIssuer = rotatedIssuer.guestGrantIssuer;
    expect(
      await firstClient.revokeGuestGrant(current.value.grantId),
    ).toMatchObject({ status: "authority_unavailable" });
    const currentIssuerClient = guestClient(first);
    const secondPlatform = createPlatformClient({
      baseUrl: testEnv.PLATFORM_BASE_URL,
      authority: testEnv.PLATFORM_AUTHORITY_ID,
      audience: second.audience,
      serviceVerifier: second.verifier,
      fetch: (input, init) => SELF.fetch(input, init),
    });

    let releaseRenewLookup!: () => void;
    const renewLookupReleased = new Promise<void>((resolve) => {
      releaseRenewLookup = resolve;
    });
    let renewLookupStarted!: () => void;
    const renewLookupObserved = new Promise<void>((resolve) => {
      renewLookupStarted = resolve;
    });
    const delayedRenewDatabase = new Proxy(testEnv.IDENTITY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = target.prepare(query);
          if (
            !query.includes(
              "SELECT guest_grant.guest_id, guest_grant.service_id",
            )
          )
            return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      return Reflect.get(
                        boundTarget,
                        boundProperty,
                        boundReceiver,
                      );
                    }
                    return async (...args: unknown[]) => {
                      const value = await (
                        boundTarget.first as (...values: unknown[]) => unknown
                      )(...args);
                      renewLookupStarted();
                      await renewLookupReleased;
                      return value;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as unknown as D1Database;
    const currentIssuer = {
      ...issuer,
      issuerHash: await hashOpaque(first.guestGrantIssuer),
    };
    const pendingRenew = (async () => {
      try {
        return await renewGuestGrant(delayedRenewDatabase, {
          issuer: currentIssuer,
          authority: testEnv.PLATFORM_AUTHORITY_ID,
          grantId: current.value.grantId,
          bootstrapCredential: guest.bootstrapCredential,
          resourceId: "t08-owned",
          capabilities: ["resource:read"],
          assertion: { kind: "owner", storedOwnerId: guest.guestId },
        });
      } catch (error) {
        if (error instanceof GuestGrantConflict)
          return { status: "conflict" as const };
        throw error;
      }
    })();
    await renewLookupObserved;
    expect(
      await currentIssuerClient.revokeGuestGrant(current.value.grantId),
    ).toMatchObject({ status: "success", revoked: true });
    releaseRenewLookup();
    expect(await pendingRenew).toMatchObject({ status: "conflict" });
    const liveSuccessor = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_credential WHERE grant_id = ? AND kind = 'guest' AND revoked_at IS NULL AND replaced_by_id IS NULL",
    )
      .bind(current.value.grantId)
      .first<{ count: number }>();
    expect(liveSuccessor?.count).toBe(0);
    expect((await platform.authenticate(current.value.credential)).status).toBe(
      "invalid_credential",
    );
    expect(
      (await platform.authenticate(sameGuestSiblingGrant.credential)).status,
    ).toBe("authenticated");
    expect(
      (
        await readResource(
          first,
          "t08-owned-sibling",
          sameGuestSiblingGrant.credential,
        )
      ).status,
    ).toBe(200);
    expect(
      (await secondPlatform.authenticate(sibling.value.credential)).status,
    ).toBe("authenticated");
    expect(
      (
        await readResource(
          second,
          "t08-second-service",
          sibling.value.credential,
        )
      ).status,
    ).toBe(200);

    const rotationRaceService = service(
      "rotation-race",
      "https://t08-rotation-race.0000.test",
    );
    await registerTestService(testEnv.IDENTITY_DB, rotationRaceService);
    let releaseRotationLookup!: () => void;
    const rotationLookupReleased = new Promise<void>((resolve) => {
      releaseRotationLookup = resolve;
    });
    let rotationLookupStarted!: () => void;
    const rotationLookupObserved = new Promise<void>((resolve) => {
      rotationLookupStarted = resolve;
    });
    const delayedRotationDatabase = new Proxy(testEnv.IDENTITY_DB, {
      get(target, property, receiver) {
        if (property !== "prepare")
          return Reflect.get(target, property, receiver);
        return (query: string) => {
          const statement = target.prepare(query);
          if (
            !query.includes(
              "SELECT credential_hash FROM platform_service_grant_issuer",
            )
          )
            return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                return Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                );
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      return Reflect.get(
                        boundTarget,
                        boundProperty,
                        boundReceiver,
                      );
                    }
                    return async (...args: unknown[]) => {
                      const value = await (
                        boundTarget.first as (...values: unknown[]) => unknown
                      )(...args);
                      rotationLookupStarted();
                      await rotationLookupReleased;
                      return value;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as unknown as D1Database;
    const staleRotation = rotateGuestIssuer(
      delayedRotationDatabase,
      rotationRaceService.serviceId,
    );
    await rotationLookupObserved;
    expect(
      await disableGuestIssuer(
        testEnv.IDENTITY_DB,
        rotationRaceService.serviceId,
      ),
    ).toBe(true);
    releaseRotationLookup();
    await expect(staleRotation).rejects.toMatchObject({
      code: "guest_issuer_disabled",
    });
    const activeRotationIssuer = await testEnv.IDENTITY_DB.prepare(
      "SELECT COUNT(*) AS count FROM platform_service_grant_issuer WHERE service_id = ? AND disabled = 0",
    )
      .bind(rotationRaceService.serviceId)
      .first<{ count: number }>();
    expect(activeRotationIssuer?.count).toBe(0);

    expect(
      (
        await currentIssuerClient.renewGuestGrant({
          grantId: current.value.grantId,
          bootstrapCredential: guest.bootstrapCredential,
          resourceId: "t08-owned",
          capabilities: ["resource:read"],
          assertion: { kind: "owner", storedOwnerId: guest.guestId },
        })
      ).status,
    ).toBe("grant_denied");

    const cookieConfig = resourceConfig(second);
    const firstCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap"),
      cookieConfig,
    );
    expect(firstCookie.status).toBe(201);
    const setCookie = firstCookie.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const firstIdentity = (await firstCookie.json()) as { guestId: string };
    const resumedCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap", {
        headers: { cookie: setCookie.split(";")[0]! },
      }),
      cookieConfig,
    );
    expect(resumedCookie.status).toBe(200);
    expect(((await resumedCookie.json()) as { guestId: string }).guestId).toBe(
      firstIdentity.guestId,
    );
    const secondCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap"),
      cookieConfig,
    );
    expect(secondCookie.status).toBe(201);
    expect(
      ((await secondCookie.json()) as { guestId: string }).guestId,
    ).not.toBe(firstIdentity.guestId);
    const invalidCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap", {
        headers: { cookie: `${setCookie.split("=")[0]}=invalid-control` },
      }),
      cookieConfig,
    );
    expect(invalidCookie.status).toBe(401);
    expect(invalidCookie.headers.get("set-cookie")).toBeNull();
    const emptyCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap", {
        headers: { cookie: `${setCookie.split("=")[0]}=` },
      }),
      cookieConfig,
    );
    expect(emptyCookie.status).toBe(401);
    expect(emptyCookie.headers.get("set-cookie")).toBeNull();

    const outageCookie = await handleGuestBootstrapRequest(
      new Request("https://fixture.test/guest/bootstrap"),
      {
        ...cookieConfig,
        fetch: async () => {
          throw new Error("outage");
        },
      },
    );
    expect(outageCookie.status).toBe(503);
    await testEnv.IDENTITY_DB.prepare(
      "UPDATE platform_guest SET disabled_at = ? WHERE id = ?",
    )
      .bind(Date.now(), guest.guestId)
      .run();
    expect(
      (await secondPlatform.authenticate(sibling.value.credential)).status,
    ).toBe("invalid_credential");
    expect(
      (await secondClient.resolveGuestControl(guest.bootstrapCredential))
        .status,
    ).toBe("invalid_guest_control");
    await disableGuestIssuer(testEnv.IDENTITY_DB, second.serviceId);
    expect((await secondClient.createGuest()).status).toBe(
      "authority_unavailable",
    );
    await disableService(testEnv.IDENTITY_DB, first.serviceId);
    expect((await currentIssuerClient.createGuest()).status).toBe(
      "authority_unavailable",
    );
  });
});
