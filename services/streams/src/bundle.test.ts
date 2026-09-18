import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { runInNewContext } from "node:vm";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
}));

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = join(projectRoot, "wrangler.jsonc");

const encodeBase64Url = (value: string | Record<string, unknown>): string =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");

async function makeAccessToken(
  publicKey: CryptoKey,
  privateKey: CryptoKey,
): Promise<{ token: string; jwk: JsonWebKey & { kid?: string } }> {
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    publicKey,
  )) as JsonWebKey & { kid?: string };
  jwk.kid = "bundle-test-key";
  const header = encodeBase64Url({ alg: "RS256", kid: jwk.kid, typ: "JWT" });
  const payload = encodeBase64Url({
    aud: "bundle-test-audience",
    email: "don@example.com",
    exp: Math.floor(Date.now() / 1000) + 300,
    iss: "https://bundle-test-team.cloudflareaccess.com",
  });
  const signed = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    signed,
  );
  return {
    token: `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`,
    jwk,
  };
}

describe("bundled browser surface", () => {
  test("executes helper code emitted by the Wrangler artifact", async () => {
    const outputDirectory = mkdtempSync("/tmp/helm-streams-bundle-test-");
    try {
      execFileSync(
        join(homedir(), ".bun/bin/bunx"),
        [
          "wrangler@4.133.0",
          "deploy",
          "--dry-run",
          "--config",
          configPath,
          "--outdir",
          outputDirectory,
        ],
        { cwd: projectRoot, encoding: "utf8" },
      );

      const workerPath = join(outputDirectory, "worker.js");
      const worker = await import(
        `${pathToFileURL(workerPath).href}?bundle-test=${crypto.randomUUID()}`
      );
      const keyPair = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const { token, jwk } = await makeAccessToken(
        keyPair.publicKey,
        keyPair.privateKey,
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (
          String(input) ===
          "https://bundle-test-team.cloudflareaccess.com/cdn-cgi/access/certs"
        ) {
          return Response.json({ keys: [jwk] });
        }
        return originalFetch(input, init);
      };

      let response: Response;
      try {
        response = await worker.default.fetch(
          new Request("https://don.0000.gold/", {
            headers: { "Cf-Access-Jwt-Assertion": token },
          }),
          {
            ACCESS_TEAM_NAME: "bundle-test-team",
            ACCESS_AUD: "bundle-test-audience",
            DON_EMAIL: "don@example.com",
            STREAMS: {},
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(response.status).toBe(200);
      const body = await response.text();
      const scriptMarker = '<script type="module">';
      const scriptStart = body.indexOf(scriptMarker);
      const scriptEnd = body.indexOf("</script>", scriptStart);
      expect(scriptStart).toBeGreaterThanOrEqual(0);
      expect(scriptEnd).toBeGreaterThan(scriptStart);
      const script = body.slice(scriptStart + scriptMarker.length, scriptEnd);
      const helperEnd = script.indexOf("const state=");
      expect(helperEnd).toBeGreaterThan(0);
      const helperSource = script.slice(0, helperEnd);
      const result = runInNewContext(
        `${helperSource}\ngroupStreamsForDisplay([${JSON.stringify({
          streamId: "needs",
          status: "needs_decision",
          needsDon: true,
          priority: 1,
          updatedAt: "2026-09-05T00:00:00.000Z",
        })}], "2026-09-06T00:00:00.000Z")`,
        {},
      ) as { needsYou: Array<{ streamId: string }> };
      expect(body).not.toContain("__name");
      expect(result.needsYou.map((stream) => stream.streamId)).toEqual([
        "needs",
      ]);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
