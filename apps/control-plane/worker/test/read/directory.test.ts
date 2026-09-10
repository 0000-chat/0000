import { env as runtimeEnv } from "cloudflare:workers";
import { ConnectionSchema } from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DirectoryReadError,
  listConnectionsForIdentity,
} from "../../control-directory/read-repository";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const timestamp = "2026-08-29T00:00:00.000Z";

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
});

describe("listConnectionsForIdentity", () => {
  it("filters by trusted tenant and identity and returns strict connection records", async () => {
    const rows = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "connection_human_whatsapp",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      capabilities: ["message.send", "receipt.read", "typing.send"],
      last_synced_at: null,
      sort_position: 0,
    });
    const first = rows[0];
    if (!first) throw new Error("connection fixture is missing");
    const { sort_position: _sortPosition, ...connection } = first;
    expect(ConnectionSchema.parse(connection)).toMatchObject({ id: "connection_human_whatsapp" });

    await expect(listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_agent",
    )).resolves.toMatchObject([{ id: "connection_agent_whatsapp", identity_id: "identity_agent" }]);
    await expect(listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_other",
      "identity_human",
    )).resolves.toEqual([]);
  });

  it("keeps disconnected and attention-required connections visible", async () => {
    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "UPDATE connections SET status = 'disconnected' WHERE id = ?",
      ).bind("connection_human_whatsapp"),
      env.CONTROL_DB.prepare(
        "UPDATE connections SET status = 'attention_required', attention_code = ?, last_synced_at = ? WHERE id = ?",
      ).bind("reauth_required", "2026-08-28T00:00:00.000Z", "connection_agent_whatsapp"),
    ]);

    const human = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    );
    const agent = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_agent",
    );
    expect(human[0]).toMatchObject({ status: "disconnected" });
    expect(agent[0]).toMatchObject({ status: "attention_required", attention_code: "reauth_required" });
  });

  it("fails closed when more than 64 connections are visible", async () => {
    const statements = Array.from({ length: 64 }, (_, index) => env.CONTROL_DB.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `connection_human_${String(index).padStart(2, "0")}`,
      "tenant_pilot",
      "identity_human",
      "whatsapp",
      `Human ${index}`,
      "ready",
      timestamp,
      timestamp,
    ));
    await env.CONTROL_DB.batch(statements);

    await expect(listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    )).rejects.toMatchObject({
      code: "read_directory_too_large",
      message: "Connection directory is too large",
    });
  });

  it("maps corrupt rows to a stable error without leaking row data", async () => {
    const corruptTimestamp = "corrupt-private-timestamp";
    await env.CONTROL_DB.prepare(
      "UPDATE connections SET last_synced_at = ? WHERE id = ?",
    ).bind(corruptTimestamp, "connection_human_whatsapp").run();

    const failure = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "read_directory_invalid",
      message: "Invalid connection directory data",
    });
    expect(String(failure)).not.toContain(corruptTimestamp);
    expect(JSON.stringify(failure)).not.toContain(corruptTimestamp);
  });
});

describe("connection capability metadata", () => {
  it("sorts capabilities and never duplicates them", async () => {
    const result = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    );
    expect(result[0]?.capabilities).toEqual(["message.send", "receipt.read", "typing.send"]);
    expect(new Set(result[0]?.capabilities).size).toBe(result[0]?.capabilities.length);
  });

  it("does not expose internal routing metadata", async () => {
    const result = await listConnectionsForIdentity(
      env.CONTROL_DB.withSession("first-primary"),
      "tenant_pilot",
      "identity_human",
    );
    expect(result[0]).not.toHaveProperty("gateway_route_id");
    expect(result[0]).not.toHaveProperty("bridge_instance_id");
    expect(result[0]).not.toHaveProperty("matrix_user_id");
  });
});

it("exports a stable directory error type", () => {
  const error = new DirectoryReadError("read_directory_invalid");
  expect(error).toMatchObject({
    code: "read_directory_invalid",
    message: "Invalid connection directory data",
  });
});
