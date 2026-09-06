import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthenticationError, parseBearerToken } from "../auth/bearer";
import { createOidcVerifier } from "../auth/oidc";
import { oidcConfig, signTestToken } from "./support/tokens";

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256");
  privateKey = keyPair.privateKey as CryptoKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", kid: "local-key" }] });
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
    expect(() => parseBearerToken(header)).toThrowError(new AuthenticationError(message));
  });
});

describe("createOidcVerifier", () => {
  const verifier = () => createOidcVerifier(oidcConfig, keys);

  it("verifies issuer, audience, and subject claims", async () => {
    const token = await signTestToken(privateKey, { subject: "human-subject", token_id: "token-one" });

    await expect(verifier().verify(token)).resolves.toEqual({
      issuer: oidcConfig.issuer,
      subject: "human-subject",
      token_id: "token-one",
    });
  });

  it("rejects a token with the wrong issuer", async () => {
    const token = await signTestToken(privateKey, { issuer: "https://other.example/" });
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
    const token = await signTestToken(otherKeyPair.privateKey, { kid: "local-key" });
    await expect(verifier().verify(token)).rejects.toThrow();
  });

  it("rejects a verified token without a subject", async () => {
    const token = await signTestToken(privateKey, { subject: null });
    await expect(verifier().verify(token)).rejects.toThrow("verified token lacks required subject claims");
  });

  it("preserves a missing token id for principal-type authorization", async () => {
    const token = await signTestToken(privateKey, { subject: "agent-subject" });
    await expect(verifier().verify(token)).resolves.toEqual({
      issuer: oidcConfig.issuer,
      subject: "agent-subject",
    });
  });
});
