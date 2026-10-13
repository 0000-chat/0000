import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { hashOpaque, opaqueSecret } from "../src/platform-state";
import {
  isValidOpaqueCredential,
  validateOpaqueCredential,
} from "./provision-service";

const script = path.resolve(import.meta.dir, "provision-service.ts");
const servicePrefix = "service_verify_";
const guestPrefix = "service_guest_grant_";

function runProvision(
  args: string[],
  input = "",
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", [script, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    input,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function makeFakeWrangler(directory: string, behavior: string): string {
  const file = path.join(directory, "fake-wrangler.mjs");
  writeFileSync(
    file,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const sql = process.argv[process.argv.indexOf("--command") + 1] ?? "";
${behavior}
`,
    { mode: 0o700 },
  );
  return file;
}

describe("provision-service credential handoff", () => {
  test("accepts only canonical opaque credentials for each operation", () => {
    const verifier = opaqueSecret(servicePrefix);
    const issuer = opaqueSecret(guestPrefix);
    expect(isValidOpaqueCredential(verifier, servicePrefix)).toBe(true);
    expect(isValidOpaqueCredential(issuer, guestPrefix)).toBe(true);
    expect(isValidOpaqueCredential(verifier, guestPrefix)).toBe(false);
    expect(
      isValidOpaqueCredential(
        `${servicePrefix}${"A".repeat(42)}B`,
        servicePrefix,
      ),
    ).toBe(false);
    expect(() =>
      validateOpaqueCredential(
        "service_verify_bad",
        servicePrefix,
        "Service verifier",
      ),
    ).toThrow();
  });

  test("generate-only does not invoke D1 and emits one capture line", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "platform-provision-"),
    );
    const marker = path.join(directory, "invoked");
    const wrapper = makeFakeWrangler(
      directory,
      `writeFileSync(${JSON.stringify(marker)}, "invoked"); process.stdout.write("[]");`,
    );
    try {
      const result = runProvision([
        "--generate-only",
        "--wrangler",
        wrapper,
        "register",
        "--service-id",
        "msg",
        "--audience",
        "https://msg.example/mcp",
        "--capability",
        "msg:read",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /^generated verifier=service_verify_[A-Za-z0-9_-]{43}\n$/,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("stdin registration adopts a hash-matching row without echoing the credential", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "platform-provision-"),
    );
    const marker = path.join(directory, "inserted");
    const verifier = opaqueSecret(servicePrefix);
    const verifierHash = await hashOpaque(verifier);
    const wrapper = makeFakeWrangler(
      directory,
      `if (sql.startsWith("SELECT")) {
  process.stdout.write(JSON.stringify([{ results: [{ service_id: "msg", audience: "https://msg.example/mcp", verifier_hash: ${JSON.stringify(verifierHash)}, allowed_capabilities: "[\\"msg:read\\"]", display_name: "", disabled: 0 }] }]));
} else {
  writeFileSync(${JSON.stringify(marker)}, "inserted");
  process.stdout.write(JSON.stringify([{ results: [] }]));
}`,
    );
    try {
      const result = runProvision(
        [
          "--credential-stdin",
          "--wrangler",
          wrapper,
          "register",
          "--service-id",
          "msg",
          "--audience",
          "https://msg.example/mcp",
          "--capability",
          "msg:read",
        ],
        `${verifier}\n`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("registered msg\n");
      expect(result.stdout).not.toContain(verifier);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("guest issuer stdin registration does not echo the issuer", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "platform-provision-"),
    );
    const wrapper = makeFakeWrangler(
      directory,
      `if (sql.startsWith("SELECT")) process.stdout.write(JSON.stringify([{ results: [] }]));
else process.stdout.write(JSON.stringify([{ results: [] }, { results: [{ changed: 1 }] }]));`,
    );
    const issuer = opaqueSecret(guestPrefix);
    try {
      const result = runProvision(
        [
          "--credential-stdin",
          "--wrangler",
          wrapper,
          "register-guest-issuer",
          "--service-id",
          "msg",
        ],
        `${issuer}\n`,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("registered-guest-issuer msg\n");
      expect(result.stdout).not.toContain(issuer);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
