import {
  REALTIME_TICKET_TTL_MS,
  type SessionResponse,
} from "@communicator/contracts";
import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RealtimeAuthorizationError,
  authorizeRealtimeRequest,
} from "../../realtime/authorization";
import {
  RealtimeTicketError,
  consumeRealtimeTicket,
  issueRealtimeTicket,
} from "../../realtime/ticket-repository";
import {
  digestRealtimeTicket,
  generateRealtimeTicket,
} from "../../realtime/token";
import { clearDirectory, seedDirectory } from "../support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const now = new Date("2026-09-10T10:00:00.000Z");
const timestamp = now.toISOString();

const humanSession: SessionResponse = {
  tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot" },
  principal: { id: "principal_human", type: "human", display_name: "Human" },
  membership: { id: "membership_human", role: "owner" },
  identities: [
    {
      identity_id: "identity_human",
      kind: "human",
      display_name: "Human",
      scopes: [
        "conversation.read",
        "message.send",
        "receipt.send",
        "connection.read",
        "connection.manage",
      ],
    },
  ],
};

const ticketRequest = {
  schema_version: 1 as const,
  subscriptions: [
    {
      identity_id: "identity_human",
      families: ["projection" as const],
    },
  ],
};

const authorizedRequest = () =>
  authorizeRealtimeRequest(humanSession, ticketRequest);

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await env.CONTROL_DB.prepare("DELETE FROM realtime_tickets").run();
});

describe("realtime ticket tokens", () => {
  it("uses exactly 32 random bytes for an rt1 base64url token", async () => {
    const supplied = Uint8Array.from({ length: 32 }, (_, index) => index);
    let received: Uint8Array | undefined;
    const ticket = generateRealtimeTicket((bytes) => {
      received = bytes;
      return supplied;
    });

    expect(received).toHaveLength(32);
    expect(ticket).toBe("rt1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(ticket).toMatch(/^rt1_[A-Za-z0-9_-]{43}$/);
    expect(ticket.slice(4)).toHaveLength(43);
    expect(await digestRealtimeTicket(ticket)).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestRealtimeTicket(ticket)).toBe(
      await digestRealtimeTicket(ticket),
    );
  });
});

describe("realtime ticket authorization", () => {
  it("creates a server-owned bounded request with a normalized empty resume", () => {
    expect(authorizedRequest()).toEqual({
      schema_version: 1,
      tenant_id: "tenant_pilot",
      principal_id: "principal_human",
      membership_id: "membership_human",
      subscriptions: ticketRequest.subscriptions,
      resume: [],
    });
  });

  it("rejects an identity without conversation.read using a safe error", () => {
    const unauthorized: SessionResponse = {
      ...humanSession,
      identities: [
        {
          ...humanSession.identities[0]!,
          scopes: ["message.send"],
        },
      ],
    };

    let failure: unknown;
    try {
      authorizeRealtimeRequest(unauthorized, ticketRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RealtimeAuthorizationError);
    expect(failure).toMatchObject({
      code: "not_found",
      message: "Realtime authorization not found",
    });
    expect(String(failure)).not.toContain("identity_human");
    expect(JSON.stringify(failure)).not.toContain("identity_human");
  });
});

describe("digest-only realtime ticket storage", () => {
  it("stores only the lowercase digest and caps the lifetime at 30 seconds", async () => {
    const issued = await issueRealtimeTicket(
      env.CONTROL_DB,
      authorizedRequest(),
      now,
    );
    const row = await env.CONTROL_DB.prepare(
      "SELECT * FROM realtime_tickets",
    ).first<Record<string, unknown>>();

    expect(issued).toEqual({
      ticket: issued.ticket,
      expires_at: new Date(
        now.getTime() + REALTIME_TICKET_TTL_MS,
      ).toISOString(),
    });
    expect(row).toMatchObject({
      ticket_digest: await digestRealtimeTicket(issued.ticket),
      tenant_id: "tenant_pilot",
      principal_id: "principal_human",
      membership_id: "membership_human",
      created_at: timestamp,
      expires_at: issued.expires_at,
      expires_at_ms: now.getTime() + REALTIME_TICKET_TTL_MS,
    });
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "created_at",
      "expires_at",
      "expires_at_ms",
      "membership_id",
      "principal_id",
      "resume_json",
      "subscriptions_json",
      "tenant_id",
      "ticket_digest",
    ]);
    expect(JSON.stringify(row)).not.toContain(issued.ticket);
    expect(row).not.toHaveProperty("ticket");
    expect(row).not.toHaveProperty("url");
  });

  it("atomically lets exactly one concurrent consumer use a ticket", async () => {
    const issued = await issueRealtimeTicket(
      env.CONTROL_DB,
      authorizedRequest(),
      now,
    );

    const results = await Promise.all([
      consumeRealtimeTicket(
        env.CONTROL_DB,
        issued.ticket,
        new Date(now.getTime() + 1_000),
      ),
      consumeRealtimeTicket(
        env.CONTROL_DB,
        issued.ticket,
        new Date(now.getTime() + 1_000),
      ),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
  });

  it("returns null for malformed, missing, expired, and reused tickets", async () => {
    expect(
      await consumeRealtimeTicket(env.CONTROL_DB, "not-a-ticket", now),
    ).toBeNull();
    expect(
      await consumeRealtimeTicket(env.CONTROL_DB, `rt1_${"a".repeat(43)}`, now),
    ).toBeNull();

    const issued = await issueRealtimeTicket(
      env.CONTROL_DB,
      authorizedRequest(),
      now,
    );
    expect(
      await consumeRealtimeTicket(
        env.CONTROL_DB,
        issued.ticket,
        new Date(now.getTime() + REALTIME_TICKET_TTL_MS),
      ),
    ).toBeNull();
    expect(
      await consumeRealtimeTicket(
        env.CONTROL_DB,
        issued.ticket,
        new Date(now.getTime() + REALTIME_TICKET_TTL_MS),
      ),
    ).toBeNull();
  });

  it("performs bounded cleanup of expired rows before issuing", async () => {
    const expiredAt = new Date(now.getTime() - 60_000);
    const expiredRows = Array.from({ length: 101 }, (_, index) => {
      const digest = `e${String(index).padStart(63, "0")}`;
      return env.CONTROL_DB.prepare(
        "INSERT INTO realtime_tickets (ticket_digest, tenant_id, principal_id, membership_id, subscriptions_json, resume_json, created_at, expires_at, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        digest,
        "tenant_pilot",
        "principal_human",
        "membership_human",
        JSON.stringify(ticketRequest.subscriptions),
        "[]",
        expiredAt.toISOString(),
        expiredAt.toISOString(),
        expiredAt.getTime(),
      );
    });
    await env.CONTROL_DB.batch(expiredRows);

    await issueRealtimeTicket(env.CONTROL_DB, authorizedRequest(), now);

    const remaining = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM realtime_tickets WHERE ticket_digest LIKE 'e%'",
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it.each(["membership", "identity", "grant", "principal", "tenant"] as const)(
    "fails closed after current %s authorization is revoked",
    async (revocation) => {
      const issued = await issueRealtimeTicket(
        env.CONTROL_DB,
        authorizedRequest(),
        now,
      );

      switch (revocation) {
        case "membership":
          await env.CONTROL_DB.prepare(
            "UPDATE memberships SET status = 'revoked', revoked_at = ? WHERE id = ?",
          )
            .bind(timestamp, "membership_human")
            .run();
          break;
        case "identity":
          await env.CONTROL_DB.prepare(
            "UPDATE identities SET status = 'disabled' WHERE id = ?",
          )
            .bind("identity_human")
            .run();
          break;
        case "grant":
          await env.CONTROL_DB.prepare(
            "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND operation_scope = ?",
          )
            .bind(
              "tenant_pilot",
              "membership_human",
              "identity_human",
              "conversation.read",
            )
            .run();
          break;
        case "principal":
          await env.CONTROL_DB.prepare(
            "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
          )
            .bind(timestamp, "principal_human")
            .run();
          break;
        case "tenant":
          await env.CONTROL_DB.prepare(
            "UPDATE tenants SET status = 'disabled' WHERE id = ?",
          )
            .bind("tenant_pilot")
            .run();
          break;
      }

      expect(
        await consumeRealtimeTicket(
          env.CONTROL_DB,
          issued.ticket,
          new Date(now.getTime() + 1_000),
        ),
      ).toBeNull();
    },
  );

  it("fails closed for malformed stored JSON and wrong tenant references", async () => {
    const malformed = await issueRealtimeTicket(
      env.CONTROL_DB,
      authorizedRequest(),
      now,
    );
    await env.CONTROL_DB.prepare(
      "UPDATE realtime_tickets SET subscriptions_json = ? WHERE ticket_digest = ?",
    )
      .bind("{}", await digestRealtimeTicket(malformed.ticket))
      .run();
    expect(
      await consumeRealtimeTicket(env.CONTROL_DB, malformed.ticket, now),
    ).toBeNull();

    await env.CONTROL_DB.batch([
      env.CONTROL_DB.prepare(
        "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind("tenant_other", "other", "Other", "active", timestamp, timestamp),
      env.CONTROL_DB.prepare(
        "INSERT INTO memberships (id, tenant_id, principal_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        "membership_other",
        "tenant_other",
        "principal_human",
        "member",
        "active",
        timestamp,
        timestamp,
      ),
    ]);
    const wrongTenant = await issueRealtimeTicket(
      env.CONTROL_DB,
      authorizedRequest(),
      now,
    );
    await env.CONTROL_DB.prepare(
      "UPDATE realtime_tickets SET tenant_id = ?, membership_id = ? WHERE ticket_digest = ?",
    )
      .bind(
        "tenant_other",
        "membership_other",
        await digestRealtimeTicket(wrongTenant.ticket),
      )
      .run();
    expect(
      await consumeRealtimeTicket(env.CONTROL_DB, wrongTenant.ticket, now),
    ).toBeNull();
  });

  it("wraps D1 failures in one safe availability error", async () => {
    const rawTicket = generateRealtimeTicket((bytes) => bytes.fill(7));
    const sqlSecret = `SQL details ${rawTicket}`;
    const failingDb = {
      withSession() {
        throw new Error(sqlSecret);
      },
    } as unknown as D1Database;

    const failure = await issueRealtimeTicket(
      failingDb,
      authorizedRequest(),
      now,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RealtimeTicketError);
    expect(failure).toMatchObject({
      code: "service_unavailable",
      message: "Realtime ticket service unavailable",
    });
    expect(String(failure)).not.toContain(rawTicket);
    expect(JSON.stringify(failure)).not.toContain(rawTicket);
    expect(String(failure)).not.toContain("SQL details");
  });
});
