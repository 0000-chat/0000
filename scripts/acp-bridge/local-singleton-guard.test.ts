import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeSingletonGuard } from "./local-singleton-guard";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("bridge singleton guard", () => {
  test("fails closed when another live owner already holds the same registration", async () => {
    const path = tempGuardPath();
    await writeFile(
      path,
      `${JSON.stringify({
        instanceId: "instance-live",
        pid: 777,
        processStartToken: "boot-1:777",
        processStartedAt: "boot-1:777",
        registrationKey: "device-1",
        updatedAt: "2026-06-22T00:00:00.000Z",
        version: 1,
      })}\n`,
      "utf8",
    );

    const guard = new BridgeSingletonGuard({
      instanceId: "instance-new",
      now: () => new Date("2026-06-22T00:01:00.000Z"),
      path,
      pid: 888,
      processStartedAt: "boot-1:888",
      readProcessStartTime: (pid) => (pid === 777 ? "boot-1:777" : undefined),
      registrationKey: "device-1",
    });

    await guard.reconcile();

    expect(guard.getStatus()).toMatchObject({
      canClaim: false,
      duplicateOwner: {
        instanceId: "instance-live",
        pid: 777,
      },
      status: "duplicate_owner",
    });
  });

  test("cleans dead owners so the same registration can recover on restart", async () => {
    const path = tempGuardPath();
    await writeFile(
      path,
      `${JSON.stringify({
        instanceId: "instance-dead",
        pid: 777,
        processStartToken: "boot-1:777",
        processStartedAt: "boot-1:777",
        registrationKey: "device-1",
        updatedAt: "2026-06-22T00:00:00.000Z",
        version: 1,
      })}\n`,
      "utf8",
    );

    const guard = new BridgeSingletonGuard({
      instanceId: "instance-new",
      now: () => new Date("2026-06-22T00:01:00.000Z"),
      path,
      pid: 888,
      processStartedAt: "boot-1:888",
      readProcessStartTime: () => undefined,
      registrationKey: "device-1",
    });

    await guard.reconcile();

    expect(guard.getStatus()).toMatchObject({
      canClaim: true,
      status: "healthy",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      instanceId: "instance-new",
      pid: 888,
      processStartedAt: "boot-1:888",
      registrationKey: "device-1",
      version: 1,
    });
  });

  test("fails closed for recent owners when process start tokens are unavailable", async () => {
    const path = tempGuardPath();
    await writeFile(
      path,
      `${JSON.stringify({
        instanceId: "instance-live",
        pid: process.pid,
        processStartedAt: "unknown-host-start",
        registrationKey: "device-1",
        updatedAt: "2026-06-22T00:00:30.000Z",
        version: 1,
      })}\n`,
      "utf8",
    );

    const guard = new BridgeSingletonGuard({
      fallbackOwnerTtlMs: 60_000,
      instanceId: "instance-new",
      now: () => new Date("2026-06-22T00:01:00.000Z"),
      path,
      pid: 888,
      processStartedAt: "unknown-host-new",
      readProcessStartTime: () => undefined,
      registrationKey: "device-1",
    });

    await guard.reconcile();

    expect(guard.getStatus()).toMatchObject({
      canClaim: false,
      duplicateOwner: {
        instanceId: "instance-live",
        pid: process.pid,
      },
      status: "duplicate_owner",
    });
  });

  test("cleans stale owners when process start tokens are unavailable and pid was reused", async () => {
    const path = tempGuardPath();
    await writeFile(
      path,
      `${JSON.stringify({
        instanceId: "instance-stale",
        pid: process.pid,
        processStartedAt: "unknown-host-start",
        registrationKey: "device-1",
        updatedAt: "2026-06-22T00:00:00.000Z",
        version: 1,
      })}\n`,
      "utf8",
    );

    const guard = new BridgeSingletonGuard({
      fallbackOwnerTtlMs: 60_000,
      instanceId: "instance-new",
      now: () => new Date("2026-06-22T00:03:00.000Z"),
      path,
      pid: 888,
      processStartedAt: "unknown-host-new",
      readProcessStartTime: () => undefined,
      registrationKey: "device-1",
    });

    await guard.reconcile();

    expect(guard.getStatus()).toMatchObject({
      canClaim: true,
      status: "healthy",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      instanceId: "instance-new",
      pid: 888,
      registrationKey: "device-1",
    });
  });
});

function tempGuardPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-singleton-guard-"));
  tempDirs.push(dir);
  return join(dir, "owner.json");
}
