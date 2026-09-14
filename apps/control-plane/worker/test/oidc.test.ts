import {
  base64url,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthenticationError, parseBearerToken } from "../auth/bearer";
import { createOidcVerifier, OidcVerificationError } from "../auth/oidc";
import { oidcConfig, signTestToken } from "./support/tokens";

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256");
  privateKey = keyPair.privateKey as CryptoKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  keys = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseBearerToken", () => {
  it("accepts a compact bearer token", () => {
    expect(parseBearerToken("Bearer abc.def_~-123")).toBe("abc.def_~-123");
  });

  it.each([
    [undefined, "missing bearer token"],
    ["Basic abc", "invalid bearer token"],
    ["Bearer ", "invalid bearer token"],
    ["Bearer abc def", "invalid bearer token"],
    ["Bearer abc=def", "invalid bearer token"],
  ])("rejects %s", (header, message) => {
    expect(() => parseBearerToken(header)).toThrowError(
      new AuthenticationError(message),
    );
  });
});

describe("createOidcVerifier", () => {
  const verifier = () => createOidcVerifier(oidcConfig, keys);

  it("verifies issuer, audience, and subject claims", async () => {
    const token = await signTestToken(privateKey, {
      subject: "human-subject",
      token_id: "token-one",
    });

    await expect(verifier().verify(token)).resolves.toEqual({
      issuer: oidcConfig.issuer,
      subject: "human-subject",
      token_id: "token-one",
    });
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await signTestToken(privateKey, {
      issuer: "https://other.example/",
    });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await signTestToken(privateKey, { audience: "other-api" });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("rejects an expired token using a frozen clock", async () => {
    const frozenNow = new Date("2026-08-29T01:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);
    const now = Math.floor(frozenNow.getTime() / 1000);
    const token = await signTestToken(privateKey, {
      issued_at: now - 120,
      expiration_time: now - 60,
    });

    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("rejects a token signed by an unknown key", async () => {
    const otherKeyPair = await generateKeyPair("ES256");
    const token = await signTestToken(otherKeyPair.privateKey, {
      kid: "local-key",
    });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("rejects a verified token without a subject", async () => {
    const token = await signTestToken(privateKey, { subject: null });
    await expect(verifier().verify(token)).rejects.toThrow(
      "verified token lacks required subject claims",
    );
  });

  it("preserves a missing token id for principal-type authorization", async () => {
    const token = await signTestToken(privateKey, { subject: "agent-subject" });
    await expect(verifier().verify(token)).resolves.toEqual({
      issuer: oidcConfig.issuer,
      subject: "agent-subject",
    });
  });

  it("classifies JOSE token failures as typed invalid errors", async () => {
    const token = await signTestToken(privateKey, { audience: "other-api" });
    await expect(verifier().verify(token)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("preserves an injected unavailable key-resolution failure", async () => {
    const unavailable = createOidcVerifier(oidcConfig, async () => {
      throw new OidcVerificationError("unavailable");
    });

    const token = await signTestToken(privateKey);
    await expect(unavailable.verify(token)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it.each([
    ["a non-2xx response", async () => new Response("down", { status: 503 })],
    ["malformed JSON", async () => new Response("{", { status: 200 })],
    [
      "an empty key set",
      async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    ],
  ])("classifies %s as unavailable", async (_name, fetch) => {
    const remote = createOidcVerifier(oidcConfig, undefined, {
      fetch: fetch as FetchImplementation,
    });
    const token = await signTestToken(privateKey, { token_id: "remote-token" });

    await expect(remote.verify(token)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("classifies an unknown kid as invalid after a usable JWKS loads", async () => {
    const publicJwk = await exportJWK(
      await generateKeyPair("ES256").then(({ publicKey }) => publicKey),
    );
    const fetch: FetchImplementation = async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: "ES256", kid: "different-key" }],
        }),
        { status: 200 },
      );
    const remote = createOidcVerifier(oidcConfig, undefined, { fetch });
    const token = await signTestToken(privateKey, {
      token_id: "remote-token",
      kid: "missing-key",
    });

    await expect(remote.verify(token)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it.each([
    [
      "a bad signature",
      async () => {
        const other = await generateKeyPair("ES256");
        return signTestToken(other.privateKey, {
          token_id: "remote-bad-signature",
        });
      },
    ],
    [
      "a wrong issuer",
      () =>
        signTestToken(privateKey, {
          issuer: "https://other.example/",
          token_id: "remote-wrong-issuer",
        }),
    ],
    [
      "a wrong audience",
      () =>
        signTestToken(privateKey, {
          audience: "other-api",
          token_id: "remote-wrong-audience",
        }),
    ],
    ["a malformed token", async () => "not-a-token"],
  ])(
    "classifies %s as invalid with a remote usable JWKS",
    async (_name, makeToken) => {
      const fetch: FetchImplementation = async () =>
        new Response(
          JSON.stringify({
            keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }],
          }),
          { status: 200 },
        );
      const remote = createOidcVerifier(oidcConfig, undefined, { fetch });

      await expect(remote.verify(await makeToken())).rejects.toMatchObject({
        code: "invalid",
      });
    },
  );

  it("classifies a disallowed algorithm as invalid with a remote usable JWKS", async () => {
    const fetch: FetchImplementation = async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }],
        }),
        { status: 200 },
      );
    const remote = createOidcVerifier(oidcConfig, undefined, { fetch });
    const signed = await signTestToken(privateKey, {
      token_id: "remote-algorithm",
    });
    const [encodedHeader, encodedPayload, signature] = signed.split(".");
    const header = base64url.encode(
      new TextEncoder().encode(
        JSON.stringify({
          alg: "HS256",
          kid: "local-key",
        }),
      ),
    );

    await expect(
      remote.verify(`${header}.${encodedPayload}.${signature}`),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    expect(encodedHeader).toMatch(/\S/);
  });

  it("keeps token failures invalid after a previous remote fetch outage", async () => {
    let calls = 0;
    const fetch: FetchImplementation = async () => {
      calls += 1;
      if (calls === 1) return new Response("down", { status: 503 });
      return new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }],
        }),
        { status: 200 },
      );
    };
    const remote = createOidcVerifier(oidcConfig, undefined, { fetch });
    const valid = await signTestToken(privateKey, {
      token_id: "remote-recovery",
    });
    await expect(remote.verify(valid)).rejects.toMatchObject({
      code: "unavailable",
    });

    const other = await generateKeyPair("ES256");
    const badSignature = await signTestToken(other.privateKey, {
      token_id: "remote-recovery",
    });
    await expect(remote.verify(badSignature)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(calls).toBe(2);
  });

  it("treats an expired ingestion token as invalid after a remote usable JWKS loads", async () => {
    const fetch: FetchImplementation = async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }],
        }),
        { status: 200 },
      );
    const remote = createOidcVerifier(
      { ...oidcConfig, audience: "communicator-ingestion" },
      undefined,
      {
        fetch,
        requireIngestionClaims: true,
        currentDate: new Date("2026-08-29T01:00:00.000Z"),
      },
    );
    const expired = await signTestToken(privateKey, {
      audience: "communicator-ingestion",
      issued_at: 1_756_438_800,
      expiration_time: 1_756_439_969,
      token_id: "remote-expired",
    });

    await expect(remote.verify(expired)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it.each([
    [
      "a P-384 key labelled ES256",
      async () => {
        const pair = await generateKeyPair("ES384");
        const jwk = await exportJWK(pair.publicKey);
        return { ...jwk, alg: "ES256", kid: "local-key" };
      },
    ],
    [
      "a malformed P-256 key",
      async () => ({
        ...publicJwk,
        alg: "ES256",
        kid: "local-key",
        x: "not-base64url",
      }),
    ],
    [
      "a key with duplicate operations",
      async () => ({
        ...publicJwk,
        alg: "ES256",
        kid: "local-key",
        key_ops: ["verify", "verify"],
      }),
    ],
  ])("treats %s as an unavailable JWKS", async (_name, makeJwk) => {
    const fetch: FetchImplementation = async () =>
      new Response(
        JSON.stringify({
          keys: [await makeJwk()],
        }),
        { status: 200 },
      );
    const remote = createOidcVerifier(oidcConfig, undefined, { fetch });
    const token = await signTestToken(privateKey, { token_id: "invalid-jwks" });

    await expect(remote.verify(token)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
