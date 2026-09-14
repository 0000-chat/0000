import { env as runtimeEnv } from "cloudflare:workers";
import {
  base64url,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";
import {
  createIngestionAuthorizationMiddleware,
  type IngestionServiceResolver,
  type IngestionAuthorizationVariables,
} from "../../auth/ingestion-middleware";
import { findActiveIngestionService } from "../../control-directory/ingestion-repository";
import {
  createOidcVerifier,
  OidcVerificationError,
  type TokenVerifier,
} from "../../auth/oidc";
import {
  INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS,
  INGESTION_TOKEN_MAX_TTL_SECONDS,
  isIngressEnabled,
} from "../../ingestion/config";

const issuer = "https://ingestion-issuer.example/";
const audience = "communicator-ingestion-test";
const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let keys: JWTVerifyGetKey;

const now = 1_788_000_000;

async function token(
  claims: {
    iat?: unknown;
    exp?: unknown;
    nbf?: unknown;
    sub?: unknown;
    jti?: unknown;
    aud?: unknown;
    iss?: unknown;
  } = {},
  signingKey = privateKey,
) {
  const payload: Record<string, unknown> = {
    sub: "service-subject",
    jti: "service-token",
    iat: now - 30,
    exp: now + 270,
    ...claims,
  };
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "ingestion-test-key" })
    .setIssuer(typeof payload.iss === "string" ? payload.iss : issuer)
    .setAudience(typeof payload.aud === "string" ? payload.aud : audience);
  delete payload.iss;
  delete payload.aud;
  return builder.sign(signingKey);
}

type AppForOptions = {
  resolveService?: IngestionServiceResolver;
  controlDb?: D1Database;
  downstream?: () => void;
  externalTouches?: {
    archive: () => void;
    queue: () => void;
    durableObject: () => void;
  };
};

function appFor(
  verifier: TokenVerifier,
  enabled = "true",
  options: AppForOptions = {},
) {
  const app = new Hono<{
    Bindings: Cloudflare.Env;
    Variables: IngestionAuthorizationVariables;
  }>();
  app.use(
    "*",
    createIngestionAuthorizationMiddleware({
      getVerifier: () => verifier,
      ...(options.resolveService === undefined
        ? {}
        : { resolveService: options.resolveService }),
    }),
  );
  app.get("*", (context) => {
    options.downstream?.();
    return context.json(context.get("ingestionAuthorization"));
  });
  const requestEnv = {
    COMMUNICATOR_INGRESS_ENABLED: enabled,
    COMMUNICATOR_INGESTION_OIDC_ISSUER: issuer,
    COMMUNICATOR_INGESTION_OIDC_AUDIENCE: audience,
    COMMUNICATOR_INGESTION_OIDC_JWKS_URL: "https://example.test/jwks",
  } as Record<string, unknown>;
  Object.defineProperties(requestEnv, {
    CONTROL_DB: {
      enumerable: true,
      get: () => options.controlDb ?? env.CONTROL_DB,
    },
    EVENT_ARCHIVE: {
      enumerable: true,
      get: () => {
        options.externalTouches?.archive();
        return undefined;
      },
    },
    INGESTION_QUEUE: {
      enumerable: true,
      get: () => {
        options.externalTouches?.queue();
        return undefined;
      },
    },
    TENANT_PROJECTION: {
      enumerable: true,
      get: () => {
        options.externalTouches?.durableObject();
        return undefined;
      },
    },
  });
  return (
    path: string | Request = "/internal/v1/ingestion/batches",
    init: RequestInit = {},
  ) => {
    if (path instanceof Request) {
      return app.request(
        path,
        undefined,
        requestEnv as unknown as Cloudflare.Env,
      );
    }
    return app.request(
      `https://example.test${path}`,
      init,
      requestEnv as unknown as Cloudflare.Env,
    );
  };
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256");
  privateKey = keyPair.privateKey as CryptoKey;
  const otherKeyPair = await generateKeyPair("ES256");
  otherPrivateKey = otherKeyPair.privateKey as CryptoKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  keys = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "ES256", kid: "ingestion-test-key" }],
  });
});

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await env.CONTROL_DB.prepare(
    "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      "principal_service",
      issuer,
      "service-subject",
      "service",
      "Ingestion service",
      "active",
      "2026-08-29T00:00:00.000Z",
      "2026-08-29T00:00:00.000Z",
    )
    .run();
});

describe("ingestion configuration", () => {
  it("uses a fixed five-minute lifetime and bounded clock tolerance", () => {
    expect(INGESTION_TOKEN_MAX_TTL_SECONDS).toBe(300);
    expect(INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS).toBe(30);
    expect(isIngressEnabled("true")).toBe(true);
    expect(isIngressEnabled("false")).toBe(false);
    expect(isIngressEnabled(undefined)).toBe(false);
  });
});

describe("ingestion authorization middleware", () => {
  it("fails closed before verifier or directory work when disabled", async () => {
    const verify = vi.fn(async () => ({
      issuer,
      subject: "service-subject",
      token_id: "service-token",
    }));
    const response = await appFor({ verify }, "false")("", {
      method: "POST",
      headers: { Authorization: "Bearer ignored" },
      body: "must not be read",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("stores only service principal metadata and ignores tenant hints", async () => {
    const verifier = createOidcVerifier(
      { issuer, audience, jwks_url: "https://example.test/jwks" },
      keys,
      { requireIngestionClaims: true, currentDate: new Date(now * 1000) },
    );
    const response = await appFor(verifier)("", {
      headers: {
        Authorization: `Bearer ${await token()}`,
        "X-Communicator-Tenant": "tenant-attacker-choice",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service_principal_id: "principal_service",
      issuer,
      token_id: "service-token",
    });
  });

  it.each([
    [undefined, "ingestion_unauthenticated"],
    ["Basic token", "ingestion_unauthenticated"],
    ["Bearer ", "ingestion_unauthenticated"],
  ])(
    "returns generic 401 for malformed bearer %s",
    async (authorization, code) => {
      const response = await appFor({ verify: vi.fn() })("", {
        headers:
          authorization === undefined ? {} : { Authorization: authorization },
      });
      expect(response.status).toBe(401);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe(code);
    },
  );

  it("maps typed OIDC invalid and unavailable failures separately", async () => {
    const invalid = await appFor({
      verify: vi.fn(async () => {
        throw new OidcVerificationError("invalid");
      }),
    })("", { headers: { Authorization: "Bearer invalid" } });
    const unavailable = await appFor({
      verify: vi.fn(async () => {
        throw new OidcVerificationError("unavailable");
      }),
    })("", { headers: { Authorization: "Bearer unavailable" } });

    expect(invalid.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(await invalid.json()).toEqual({
      error: {
        code: "ingestion_unauthenticated",
        message: "Ingestion authentication failed",
      },
    });
    expect(await unavailable.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });
  });
});

describe("ingestion OIDC temporal contract", () => {
  function verifier() {
    return createOidcVerifier(
      { issuer, audience, jwks_url: "https://example.test/jwks" },
      keys,
      { requireIngestionClaims: true, currentDate: new Date(now * 1000) },
    );
  }

  it.each([
    ["missing iat", { iat: undefined }],
    ["missing exp", { exp: undefined }],
    ["non-integer iat", { iat: now - 30.5 }],
    ["non-integer exp", { exp: now + 270.5 }],
    ["exp before iat", { iat: now + 10, exp: now }],
    ["overlong lifetime", { iat: now - 30, exp: now + 271 }],
    ["iat too far in future", { iat: now + 31, exp: now + 331 }],
    ["nbf too far in future", { nbf: now + 31 }],
    ["missing subject", { sub: undefined }],
    ["missing jti", { jti: undefined }],
  ])("rejects %s", async (_name, claims) => {
    await expect(verifier().verify(await token(claims))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("accepts exactly a 300-second signed lifetime", async () => {
    await expect(
      verifier().verify(await token({ iat: now - 100, exp: now + 200 })),
    ).resolves.toMatchObject({
      subject: "service-subject",
      token_id: "service-token",
    });
  });

  it("does not add clock tolerance to the signed lifetime", async () => {
    await expect(
      verifier().verify(await token({ iat: now - 100, exp: now + 201 })),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("allows the configured clock tolerance only for comparisons", async () => {
    await expect(
      verifier().verify(
        await token({
          iat: now + INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS,
          exp: now + 300,
        }),
      ),
    ).resolves.toMatchObject({ subject: "service-subject" });
  });
});

describe("ingestion authorization denial boundary", () => {
  function verifier() {
    return createOidcVerifier(
      { issuer, audience, jwks_url: "https://example.test/jwks" },
      keys,
      { requireIngestionClaims: true, currentDate: new Date(now * 1000) },
    );
  }

  async function expectUnauthorized(
    makeToken: () => Promise<string>,
    expectedStatus = 401,
  ) {
    const response = await appFor(verifier())("", {
      headers: { Authorization: `Bearer ${await makeToken()}` },
    });
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({
      error:
        expectedStatus === 401
          ? {
              code: "ingestion_unauthenticated",
              message: "Ingestion authentication failed",
            }
          : {
              code: "ingestion_not_found",
              message: "Ingestion resource not found",
            },
    });
  }

  it("returns one generic 401 for invalid signature, issuer, audience, and algorithm", async () => {
    await expectUnauthorized(() => token({}, otherPrivateKey));
    await expectUnauthorized(() => token({ iss: "https://other.example/" }));
    await expectUnauthorized(() => token({ aud: "communicator-api" }));

    const signed = await token();
    const [, encodedPayload, signature] = signed.split(".");
    const header = base64url.encode(
      new TextEncoder().encode(
        JSON.stringify({
          alg: "HS256",
          kid: "ingestion-test-key",
        }),
      ),
    );
    await expectUnauthorized(
      async () => `${header}.${encodedPayload}.${signature}`,
    );
  });

  it("returns 401 for an expiration more than the clock tolerance in the past", async () => {
    await expectUnauthorized(() =>
      token({
        iat: now - 300,
        exp: now - INGESTION_TOKEN_CLOCK_TOLERANCE_SECONDS - 1,
      }),
    );
  });

  it.each([
    ["missing subject", { sub: undefined }],
    ["missing jti", { jti: undefined }],
    ["missing iat", { iat: undefined }],
    ["missing exp", { exp: undefined }],
    ["non-integer iat", { iat: now - 30.5 }],
    ["non-integer exp", { exp: now + 270.5 }],
    ["exp <= iat", { iat: now, exp: now }],
    ["overlong lifetime", { iat: now - 100, exp: now + 201 }],
    ["iat too far in the future", { iat: now + 31, exp: now + 331 }],
    ["nbf too far in the future", { nbf: now + 31 }],
  ])(
    "returns 401 for %s before directory resolution",
    async (_name, claims) => {
      const resolveService = vi.fn<IngestionServiceResolver>(
        findActiveIngestionService,
      );
      const response = await appFor(verifier(), "true", { resolveService })(
        "",
        {
          headers: { Authorization: `Bearer ${await token(claims)}` },
        },
      );

      expect(response.status).toBe(401);
      expect(resolveService).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({
        error: {
          code: "ingestion_unauthenticated",
          message: "Ingestion authentication failed",
        },
      });
    },
  );

  it("rejects a revoked jti at the HTTP boundary", async () => {
    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        issuer,
        "revoked-http-token",
        "principal_service",
        "test revocation",
        "2026-08-29T00:00:00.000Z",
      )
      .run();

    await expectUnauthorized(() => token({ jti: "revoked-http-token" }), 404);
  });

  it.each([
    ["human", "principal_ingestion_human", "human-subject", "owner"],
    ["agent", "principal_ingestion_agent", "agent-subject", "member"],
  ])(
    "rejects a %s principal even when it has tenant membership",
    async (_kind, id, subject, role) => {
      await env.CONTROL_DB.prepare(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          id,
          issuer,
          subject,
          _kind,
          _kind,
          "active",
          "2026-08-29T00:00:00.000Z",
          "2026-08-29T00:00:00.000Z",
        )
        .run();
      await env.CONTROL_DB.prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          `membership_${id}`,
          "tenant_pilot",
          id,
          role,
          "active",
          "2026-08-29T00:00:00.000Z",
          "2026-08-29T00:00:00.000Z",
        )
        .run();

      await expectUnauthorized(() => token({ sub: subject }), 404);
    },
  );

  it.each(["disabled", "revoked"])(
    "returns 404 for an inactive service principal (%s)",
    async (status) => {
      if (status === "disabled") {
        await env.CONTROL_DB.prepare(
          "UPDATE principals SET status = ? WHERE id = ?",
        )
          .bind(status, "principal_service")
          .run();
      } else {
        await env.CONTROL_DB.prepare(
          "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
        )
          .bind("2026-08-29T00:00:00.000Z", "principal_service")
          .run();
      }

      await expectUnauthorized(() => token(), 404);
    },
  );

  it("maps an unavailable directory to a fixed 503", async () => {
    const controlDb = {
      withSession: () => {
        throw new Error("D1 unavailable secret");
      },
    } as unknown as D1Database;
    const response = await appFor(verifier(), "true", { controlDb })("", {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });
  });

  it("maps an unavailable JWKS to a fixed 503 before directory resolution", async () => {
    const resolveService = vi.fn<IngestionServiceResolver>(
      findActiveIngestionService,
    );
    const unavailableVerifier = createOidcVerifier(
      { issuer, audience, jwks_url: "https://example.test/jwks" },
      undefined,
      {
        fetch: async () => new Response("down", { status: 503 }),
        requireIngestionClaims: true,
        currentDate: new Date(now * 1000),
      },
    );
    const response = await appFor(unavailableVerifier, "true", {
      resolveService,
    })("", {
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(response.status).toBe(503);
    expect(resolveService).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });
  });

  it("emits only a fixed denial log shape", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expectUnauthorized(() => token({ aud: "communicator-api" }));
      expect(log).toHaveBeenCalledWith({
        event: "ingestion_auth_denied",
        status: 401,
        code: "ingestion_unauthenticated",
      });
      for (const call of log.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("communicator-api");
        expect(JSON.stringify(call)).not.toContain("service-token");
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("ingestion revocation ordering and disabled zero-work", () => {
  function verifier() {
    return createOidcVerifier(
      { issuer, audience, jwks_url: "https://example.test/jwks" },
      keys,
      { requireIngestionClaims: true, currentDate: new Date(now * 1000) },
    );
  }

  async function expectTemporalCredentialDenied(
    tokenId: string,
    claims: { exp?: unknown; iat?: unknown },
  ) {
    const resolveService = vi.fn<IngestionServiceResolver>();
    const downstream = vi.fn();
    const touches = {
      archive: vi.fn(),
      queue: vi.fn(),
      durableObject: vi.fn(),
    };
    const response = await appFor(verifier(), "true", {
      resolveService,
      downstream,
      externalTouches: touches,
    })("", {
      headers: {
        Authorization: `Bearer ${await token({ ...claims, jti: tokenId })}`,
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_unauthenticated",
        message: "Ingestion authentication failed",
      },
    });
    expect(resolveService).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
    expect(touches.archive).not.toHaveBeenCalled();
    expect(touches.queue).not.toHaveBeenCalled();
    expect(touches.durableObject).not.toHaveBeenCalled();
  }

  it("keeps a revoked principal denied after every allowed reversal attempt", async () => {
    await env.CONTROL_DB.prepare(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
    )
      .bind("2026-08-29T00:00:00.000Z", "principal_service")
      .run();

    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE principals SET status = 'active', revoked_at = NULL WHERE id = ?",
      )
        .bind("principal_service")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE principals SET revoked_at = ? WHERE id = ?",
      )
        .bind("2026-08-30T00:00:00.000Z", "principal_service")
        .run(),
    ).rejects.toThrow();

    const downstream = vi.fn();
    const response = await appFor(verifier(), "true", { downstream })("", {
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(response.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();

    await expectTemporalCredentialDenied("service-token", { exp: undefined });
    await expectTemporalCredentialDenied("service-token", {
      iat: now - 100,
      exp: now + INGESTION_TOKEN_MAX_TTL_SECONDS + 1 - 100,
    });
  });

  it("keeps a revoked jti denied after update/delete reversal attempts", async () => {
    await env.CONTROL_DB.prepare(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        issuer,
        "reversal-token",
        "principal_service",
        "test revocation",
        "2026-08-29T00:00:00.000Z",
      )
      .run();
    await expect(
      env.CONTROL_DB.prepare(
        "UPDATE revoked_tokens SET reason = ? WHERE issuer = ? AND token_id = ?",
      )
        .bind("reversed", issuer, "reversal-token")
        .run(),
    ).rejects.toThrow();
    await expect(
      env.CONTROL_DB.prepare(
        "DELETE FROM revoked_tokens WHERE issuer = ? AND token_id = ?",
      )
        .bind(issuer, "reversal-token")
        .run(),
    ).rejects.toThrow();

    const resolveService = vi.fn<IngestionServiceResolver>(
      findActiveIngestionService,
    );
    const response = await appFor(verifier(), "true", { resolveService })("", {
      headers: {
        Authorization: `Bearer ${await token({ jti: "reversal-token" })}`,
      },
    });
    expect(response.status).toBe(404);
    expect(resolveService).toHaveBeenCalledOnce();

    await expectTemporalCredentialDenied("reversal-token", { exp: undefined });
    await expectTemporalCredentialDenied("reversal-token", {
      iat: now - 100,
      exp: now + INGESTION_TOKEN_MAX_TTL_SECONDS + 1 - 100,
    });
  });

  it("does no verifier, directory, body, downstream, or binding work while disabled", async () => {
    const verify = vi.fn(async () => ({
      issuer,
      subject: "service-subject",
      token_id: "service-token",
    }));
    const resolveService = vi.fn<IngestionServiceResolver>();
    const downstream = vi.fn();
    const touches = {
      archive: vi.fn(),
      queue: vi.fn(),
      durableObject: vi.fn(),
    };
    const request = new Request(
      "https://example.test/internal/v1/ingestion/batches",
      {
        method: "POST",
        headers: { Authorization: "Bearer ignored" },
        body: "secret body",
      },
    );
    const response = await appFor({ verify }, "false", {
      resolveService,
      downstream,
      externalTouches: touches,
    })(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "ingestion_unavailable",
        message: "Ingestion service is unavailable",
      },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(resolveService).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(touches.archive).not.toHaveBeenCalled();
    expect(touches.queue).not.toHaveBeenCalled();
    expect(touches.durableObject).not.toHaveBeenCalled();
  });
});
