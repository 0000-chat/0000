import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendLocalBridgeAudit,
  createLocalAuditBridgeLogger,
  getDefaultBridgeAuditPath,
  sanitizeBridgeAuditEntry,
} from "./local-audit-log";

async function tempAuditPath() {
  const dir = await mkdtemp(join(tmpdir(), "bridge-audit-"));
  return {
    dir,
    path: join(dir, ".0000", "bridge-audit.jsonl"),
  };
}

describe("local bridge audit log", () => {
  test("defaults to ~/.0000/bridge-audit.jsonl unless overridden", () => {
    expect(getDefaultBridgeAuditPath({})).toEndWith("/.0000/bridge-audit.jsonl");
    expect(getDefaultBridgeAuditPath({ ZERO_CHAT_BRIDGE_AUDIT_LOG: "/tmp/custom.jsonl" })).toBe(
      "/tmp/custom.jsonl",
    );
  });

  test("redacts secrets, raw command content, and local identifiers", () => {
    const sanitized = sanitizeBridgeAuditEntry({
      event: "bridge.systemd.unit_call",
      level: "info",
      queueId: "queue-secret-id",
      threadId: "thread-secret-id",
      caller: {
        basename: "systemctl",
        cmdline: "systemctl --user stop 0000-chat-bridge.service",
        cmdlineHash: "abc123",
        authorization: "Bearer live-token",
      },
      prompt: "private prompt",
    });

    expect(sanitized.queueId).toStartWith("[sha256:");
    expect(sanitized.threadId).toStartWith("[sha256:");
    expect(JSON.stringify(sanitized)).not.toContain("queue-secret-id");
    expect(JSON.stringify(sanitized)).not.toContain("thread-secret-id");
    expect(JSON.stringify(sanitized)).not.toContain("private prompt");
    expect(JSON.stringify(sanitized)).not.toContain("systemctl --user stop");
    expect(JSON.stringify(sanitized)).not.toContain("live-token");
    expect(sanitized.caller).toMatchObject({
      basename: "systemctl",
      cmdline: "[redacted]",
      cmdlineHash: "abc123",
      authorization: "[redacted]",
    });
  });

  test("writes owner-only jsonl entries", async () => {
    const { dir, path } = await tempAuditPath();
    try {
      appendLocalBridgeAudit(
        {
          event: "bridge.audit",
          level: "info",
          reason: "unit test",
        },
        { path },
      );

      const file = await stat(path);
      const parent = await stat(join(dir, ".0000"));
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

      expect(file.mode & 0o777).toBe(0o600);
      expect(parent.mode & 0o777).toBe(0o700);
      expect(entry).toMatchObject({
        event: "bridge.audit",
        level: "info",
        reason: "unit test",
        schemaVersion: 1,
        service: "acp-bridge",
      });
      expect(typeof entry.pid).toBe("number");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("does not write when disabled", async () => {
    const { dir, path } = await tempAuditPath();
    try {
      appendLocalBridgeAudit(
        { event: "bridge.audit", level: "info" },
        { env: { ZERO_CHAT_BRIDGE_AUDIT_DISABLED: "1" }, path },
      );

      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("rotates before appending when size exceeds the limit", async () => {
    const { dir, path } = await tempAuditPath();
    try {
      await mkdir(join(dir, ".0000"), { recursive: true });
      await writeFile(path, "x".repeat(12), { mode: 0o600 });
      appendLocalBridgeAudit(
        { event: "bridge.audit", level: "info", reason: "after rotate" },
        { maxBytes: 10, maxFiles: 2, path },
      );

      expect(await readFile(`${path}.1`, "utf8")).toBe("x".repeat(12));
      expect(await readFile(path, "utf8")).toContain("after rotate");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("logger reports write failures to stderr without throwing", () => {
    const stderrWrites: string[] = [];
    const logger = createLocalAuditBridgeLogger({
      path: "/dev/null/bridge-audit.jsonl",
      stderr: {
        write(chunk: string) {
          stderrWrites.push(chunk);
          return true;
        },
      },
    });

    expect(() => logger({ event: "bridge.audit", level: "info" })).not.toThrow();
    expect(stderrWrites.join("")).toContain("bridge.audit.write_failed");
  });
});
