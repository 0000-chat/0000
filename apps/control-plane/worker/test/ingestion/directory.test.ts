import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findActiveIngestionService,
  resolveActiveIngestionRoute,
  resolveActiveIngressBindings,
  resolveArchivedBindings,
  resolveArchivedIngestionRoute,
} from "../../control-directory/ingestion-repository";
import { clearDirectory } from "../support/directory-fixtures";

const db = (env as typeof env & { CONTROL_DB: D1Database }).CONTROL_DB;
const timestamp = "2026-08-29T00:00:00.000Z";
const issuer = "https://issuer.example/";

beforeEach(async () => {
  await clearDirectory(db);
});

const insert = async (sql: string, ...values: unknown[]) => {
  await db.prepare(sql).bind(...values).run();
};

async function seedRouting(prefix: string, options: {
  routeStatus?: "active" | "disabled" | "revoked";
  routeRevokedAt?: string | null;
  serviceStatus?: "active" | "disabled" | "revoked";
  serviceRevokedAt?: string | null;
  tenantStatus?: "active" | "disabled" | "revoked";
  identityStatus?: "active" | "disabled" | "revoked";
  connectionStatus?: "connected" | "syncing" | "ready" | "attention_required" | "disconnected" | "revoked" | "unlinked";
  accountStatus?: "active" | "retired";
  retiredAt?: string | null;
  provider?: "whatsapp" | "telegram" | "messenger" | "linkedin";
} = {}) {
  const routeStatus = options.routeStatus ?? "active";
  const routeRevokedAt = options.routeRevokedAt ?? (routeStatus === "revoked" ? timestamp : null);
  const serviceStatus = options.serviceStatus ?? "active";
  const serviceRevokedAt = options.serviceRevokedAt ?? (serviceStatus === "revoked" ? timestamp : null);
  const tenantStatus = options.tenantStatus ?? "active";
  const identityStatus = options.identityStatus ?? "active";
  const connectionStatus = options.connectionStatus ?? "ready";
  const accountStatus = options.accountStatus ?? "active";
  const retiredAt = options.retiredAt ?? (accountStatus === "retired" ? timestamp : null);
  const provider = options.provider ?? "whatsapp";
  const tenantId = `tenant_${prefix}`;
  const serviceId = `principal_service_${prefix}`;
  const routeId = `gateway_route_${prefix}`;
  const identityId = `identity_${prefix}`;
  const connectionId = `connection_${prefix}`;
  const accountId = `account_${prefix}`;

  await db.batch([
    db.prepare(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(tenantId, prefix, prefix, tenantStatus, timestamp, timestamp),
    db.prepare(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(serviceId, issuer, `subject_${prefix}`, "service", "Service", serviceStatus, timestamp, timestamp, serviceRevokedAt),
    db.prepare(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(routeId, serviceId, routeStatus, timestamp, timestamp, routeRevokedAt),
    db.prepare(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(identityId, tenantId, "human", "Human", identityStatus, timestamp, timestamp),
    db.prepare(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(connectionId, tenantId, identityId, provider, "WhatsApp", connectionStatus, timestamp, timestamp),
    db.prepare(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(connectionId, routeId, "bridge", "matrix_user", "room_namespace", timestamp, timestamp),
    db.prepare(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at, retired_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(accountId, connectionId, accountStatus, timestamp, timestamp, retiredAt),
  ]);

  return { tenantId, serviceId, routeId, identityId, connectionId, accountId };
}

describe("ingestion control-directory repository", () => {
  it("finds only an active service principal and rejects revoked JWT IDs", async () => {
    await seedRouting("service_active");
    await seedRouting("service_disabled", { serviceStatus: "disabled" });
    await seedRouting("service_revoked", { serviceStatus: "revoked" });
    for (const [id, subject, principalType] of [
      ["principal_human_rejected", "human_rejected", "human"],
      ["principal_agent_rejected", "agent_rejected", "agent"],
      ["principal_operator_rejected", "operator_rejected", "operator"],
    ] as const) {
      await insert(
        "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        issuer,
        subject,
        principalType,
        principalType,
        "active",
        timestamp,
        timestamp,
      );
    }
    await insert(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
      issuer,
      "jti_revoked",
      "principal_service_service_active",
      "security review",
      timestamp,
    );

    await expect(findActiveIngestionService(db, issuer, "subject_service_active", "jti_active"))
      .resolves.toEqual({
        ok: true,
        value: {
          service_principal_id: "principal_service_service_active",
          issuer,
          subject: "subject_service_active",
          token_id: "jti_active",
        },
      });
    await expect(findActiveIngestionService(db, issuer, "subject_service_active", "jti_revoked"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "subject_service_disabled", "jti_disabled"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "subject_service_revoked", "jti_revoked_service"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "human_rejected", "jti_human"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "agent_rejected", "jti_agent"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "operator_rejected", "jti_operator"))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(findActiveIngestionService(db, issuer, "subject_service_active", ""))
      .resolves.toEqual({ ok: false, code: "not_found" });
  });

  it("preserves unreferenced revoked principal tombstones against deletion and reinsertion", async () => {
    const principalId = "principal_unreferenced_revoked";
    const principalIssuer = "https://unreferenced.example/";
    const principalSubject = "unreferenced-revoked";
    await insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      principalId,
      principalIssuer,
      principalSubject,
      "service",
      "Unreferenced service",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
      timestamp,
      principalId,
    );

    await expect(insert("DELETE FROM principals WHERE id = ?", principalId)).rejects.toThrow();
    await expect(insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "principal_unreferenced_replacement",
      principalIssuer,
      principalSubject,
      "service",
      "Replacement",
      "active",
      timestamp,
      timestamp,
    )).rejects.toThrow();
    await expect(insert(
      "INSERT OR REPLACE INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      principalId,
      principalIssuer,
      "replacement-subject",
      "service",
      "Replacement",
      "active",
      timestamp,
      timestamp,
    )).rejects.toThrow();

    await expect(db.prepare(
      "SELECT id, issuer, subject, principal_type, display_name, status, created_at, updated_at, revoked_at FROM principals WHERE id = ?",
    ).bind(principalId).first()).resolves.toEqual({
      id: principalId,
      issuer: principalIssuer,
      subject: principalSubject,
      principal_type: "service",
      display_name: "Unreferenced service",
      status: "revoked",
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: timestamp,
    });
    await expect(findActiveIngestionService(db, principalIssuer, principalSubject, "jti_unreferenced"))
      .resolves.toEqual({ ok: false, code: "not_found" });

    const deletablePrincipalId = "principal_unreferenced_deletable";
    await insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      deletablePrincipalId,
      principalIssuer,
      "unreferenced-deletable",
      "service",
      "Deletable service",
      "active",
      timestamp,
      timestamp,
    );
    await expect(insert("DELETE FROM principals WHERE id = ?", deletablePrincipalId)).resolves.toBeUndefined();
  });

  it("blocks revoked principal identity rewrites and UPDATE OR REPLACE tombstone hijacks", async () => {
    const revokedId = "principal_identity_rewrite_revoked";
    const revokedIssuer = "https://identity-rewrite.example/";
    const revokedSubject = "identity-rewrite-revoked";
    const activeId = "principal_identity_rewrite_active";
    await insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      revokedId,
      revokedIssuer,
      revokedSubject,
      "service",
      "Revoked service",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      activeId,
      "https://identity-rewrite-active.example/",
      "identity-rewrite-active",
      "service",
      "Active service",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
      timestamp,
      revokedId,
    );

    const recursiveTriggers = await db.prepare("PRAGMA recursive_triggers").first<{ recursive_triggers: number }>();
    expect(recursiveTriggers?.recursive_triggers).toBe(0);
    for (const [column, value] of [
      ["id", "principal_identity_rewrite_renamed"],
      ["issuer", "https://identity-rewrite-renamed.example/"],
      ["subject", "identity-rewrite-renamed"],
      ["principal_type", "agent"],
    ] as const) {
      await expect(insert(
        `UPDATE principals SET ${column} = ? WHERE id = ?`,
        value,
        revokedId,
      )).rejects.toThrow();
    }

    const beforeRows = (await db.prepare(
      "SELECT id, issuer, subject, principal_type, status, revoked_at FROM principals WHERE id IN (?, ?) ORDER BY id",
    ).bind(revokedId, activeId).all()).results;
    await expect(insert(
      "UPDATE OR REPLACE principals SET issuer = ?, subject = ? WHERE id = ?",
      revokedIssuer,
      revokedSubject,
      activeId,
    )).rejects.toThrow();
    await expect(db.prepare(
      "SELECT id, issuer, subject, principal_type, status, revoked_at FROM principals WHERE id IN (?, ?) ORDER BY id",
    ).bind(revokedId, activeId).all()).resolves.toMatchObject({ results: beforeRows });

    await insert(
      "UPDATE principals SET display_name = ? WHERE id = ?",
      "Renamed but still revoked",
      revokedId,
    );
    await expect(db.prepare(
      "SELECT id, issuer, subject, principal_type, status, revoked_at FROM principals WHERE id = ?",
    ).bind(revokedId).first()).resolves.toEqual({
      id: revokedId,
      issuer: revokedIssuer,
      subject: revokedSubject,
      principal_type: "service",
      status: "revoked",
      revoked_at: timestamp,
    });
    await expect(findActiveIngestionService(db, revokedIssuer, revokedSubject, "jti_identity_rewrite"))
      .resolves.toEqual({ ok: false, code: "not_found" });
  });

  it("resolves active routes only for their active service owner and archives inactive routes", async () => {
    const active = await seedRouting("route_active");
    const disabled = await seedRouting("route_disabled", { routeStatus: "disabled" });
    const revoked = await seedRouting("route_revoked", { routeStatus: "revoked" });
    const inactiveOwner = await seedRouting("route_inactive_owner", { serviceStatus: "disabled" });
    const otherActiveOwner = await seedRouting("route_other_active_owner");

    await expect(resolveActiveIngestionRoute(db, active.serviceId, active.routeId)).resolves.toEqual({
      ok: true,
      value: { gateway_route_id: active.routeId, service_principal_id: active.serviceId },
    });
    await expect(resolveActiveIngestionRoute(db, active.serviceId, disabled.routeId))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngestionRoute(db, active.serviceId, otherActiveOwner.routeId))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngestionRoute(db, inactiveOwner.serviceId, inactiveOwner.routeId))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngestionRoute(db, active.serviceId, revoked.routeId))
      .resolves.toEqual({ ok: false, code: "not_found" });

    await expect(resolveArchivedIngestionRoute(db, disabled.routeId)).resolves.toEqual({
      ok: true,
      value: { gateway_route_id: disabled.routeId, service_principal_id: disabled.serviceId },
    });
    await expect(resolveArchivedIngestionRoute(db, revoked.routeId)).resolves.toEqual({
      ok: true,
      value: { gateway_route_id: revoked.routeId, service_principal_id: revoked.serviceId },
    });
    await expect(resolveArchivedIngestionRoute(db, inactiveOwner.routeId)).resolves.toEqual({
      ok: true,
      value: { gateway_route_id: inactiveOwner.routeId, service_principal_id: inactiveOwner.serviceId },
    });
  });

  it("returns active bindings sorted uniquely and accepts drainable connection states", async () => {
    const primary = await seedRouting("bindings_primary", { connectionStatus: "attention_required" });
    await insert(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "connection_bindings_extra",
      primary.tenantId,
      primary.identityId,
      "whatsapp",
      "WhatsApp extra",
      "disconnected",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "connection_bindings_extra",
      primary.routeId,
      "bridge_extra",
      "matrix_user_extra",
      "room_extra",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      "account_bindings_extra",
      "connection_bindings_extra",
      "active",
      timestamp,
      timestamp,
    );

    await expect(resolveActiveIngressBindings(
      db,
      primary.routeId,
      primary.tenantId,
      ["account_bindings_extra", primary.accountId],
    )).resolves.toEqual({
      ok: true,
      value: [
        {
          account_id: "account_bindings_extra",
          connection_id: "connection_bindings_extra",
          identity_id: primary.identityId,
          platform: "whatsapp",
          gateway_route_id: primary.routeId,
          account_status: "active",
        },
        {
          account_id: primary.accountId,
          connection_id: primary.connectionId,
          identity_id: primary.identityId,
          platform: "whatsapp",
          gateway_route_id: primary.routeId,
          account_status: "active",
        },
      ],
    });
    await expect(resolveActiveIngressBindings(db, primary.routeId, primary.tenantId, [primary.accountId, "account_bindings_missing"]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, primary.routeId, primary.tenantId, [primary.accountId, primary.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, primary.routeId, primary.tenantId, ["account_missing"]))
      .resolves.toEqual({ ok: false, code: "not_found" });
  });

  it("denies inactive ingress lifecycle states but lets archived replay resolve retired mappings", async () => {
    const retired = await seedRouting("bindings_retired", { accountStatus: "retired" });
    const inactiveTenant = await seedRouting("bindings_inactive_tenant", { tenantStatus: "disabled" });
    const inactiveIdentity = await seedRouting("bindings_inactive_identity", { identityStatus: "disabled" });
    const revokedConnection = await seedRouting("bindings_revoked_connection", { connectionStatus: "revoked" });
    const unlinkedConnection = await seedRouting("bindings_unlinked_connection", { connectionStatus: "unlinked" });

    await expect(resolveActiveIngressBindings(db, retired.routeId, retired.tenantId, [retired.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, inactiveTenant.routeId, inactiveTenant.tenantId, [inactiveTenant.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, inactiveIdentity.routeId, inactiveIdentity.tenantId, [inactiveIdentity.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, revokedConnection.routeId, revokedConnection.tenantId, [revokedConnection.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await expect(resolveActiveIngressBindings(db, unlinkedConnection.routeId, unlinkedConnection.tenantId, [unlinkedConnection.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });

    await expect(resolveArchivedBindings(db, retired.routeId, retired.tenantId, [retired.accountId]))
      .resolves.toMatchObject({ ok: true, value: [{ account_id: retired.accountId, account_status: "retired" }] });
    await expect(resolveArchivedBindings(db, inactiveTenant.routeId, inactiveTenant.tenantId, [inactiveTenant.accountId]))
      .resolves.toMatchObject({ ok: true });
    await expect(resolveArchivedBindings(db, revokedConnection.routeId, revokedConnection.tenantId, [revokedConnection.accountId]))
      .resolves.toMatchObject({ ok: true });
  });

  it("keeps two tenants and two routes isolated across WhatsApp, Telegram, and Messenger", async () => {
    const first = await seedRouting("tenant_one_whatsapp");
    const second = await seedRouting("tenant_two_telegram", { provider: "telegram" });
    await insert(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "connection_tenant_one_messenger",
      first.tenantId,
      first.identityId,
      "messenger",
      "Messenger",
      "ready",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "connection_tenant_one_messenger",
      first.routeId,
      "bridge_messenger",
      "matrix_user_messenger",
      "room_messenger",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      "account_tenant_one_messenger",
      "connection_tenant_one_messenger",
      "active",
      timestamp,
      timestamp,
    );

    await expect(resolveActiveIngressBindings(db, first.routeId, first.tenantId, [first.accountId]))
      .resolves.toMatchObject({ ok: true, value: [{ platform: "whatsapp" }] });
    await expect(resolveActiveIngressBindings(db, first.routeId, first.tenantId, ["account_tenant_one_messenger"]))
      .resolves.toMatchObject({ ok: true, value: [{ platform: "messenger" }] });
    await expect(resolveActiveIngressBindings(db, second.routeId, second.tenantId, [second.accountId]))
      .resolves.toMatchObject({ ok: true, value: [{ platform: "telegram" }] });
    await expect(resolveActiveIngressBindings(db, first.routeId, second.tenantId, [second.accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
  });

  it("maps D1 exceptions to a generic unavailable result and reads from first-primary", async () => {
    const failureDb = {
      withSession: () => ({
        prepare: () => {
          throw new Error("sensitive SQL details");
        },
      }),
    } as unknown as D1Database;
    await expect(findActiveIngestionService(failureDb, issuer, "subject", "jti"))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(resolveActiveIngestionRoute(failureDb, "principal_service", "gateway_route_one"))
      .resolves.toEqual({ ok: false, code: "unavailable" });

    const observed: string[] = [];
    const observingDb = {
      withSession(consistency: string) {
        observed.push(consistency);
        return {
          prepare() {
            return {
              bind() {
                return {
                  first: async () => null,
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await findActiveIngestionService(observingDb, issuer, "subject", "jti");
    expect(observed).toEqual(["first-primary"]);
  });

  it("registers a legacy route explicitly before active ingestion can resolve it", async () => {
    const tenantId = "tenant_legacy_repository";
    const serviceId = "principal_service_legacy_repository";
    const identityId = "identity_legacy_repository";
    const connectionId = "connection_legacy_repository";
    const legacyRouteId = "gateway_legacy_repository";
    const routeId = "gateway_route_legacy_repository";
    const accountId = "account_legacy_repository";

    await insert(
      "INSERT INTO tenants (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      tenantId,
      "legacy",
      "Legacy",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO principals (id, issuer, subject, principal_type, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      serviceId,
      issuer,
      "subject_legacy_repository",
      "service",
      "Service",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO identities (id, tenant_id, identity_kind, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      identityId,
      tenantId,
      "human",
      "Human",
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      connectionId,
      tenantId,
      identityId,
      "whatsapp",
      "WhatsApp",
      "ready",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      connectionId,
      legacyRouteId,
      "bridge_legacy_repository",
      "matrix_user_legacy_repository",
      "room_legacy_repository",
      timestamp,
      timestamp,
    );

    await expect(resolveActiveIngressBindings(db, legacyRouteId, tenantId, [accountId]))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await insert(
      "UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?",
      routeId,
      connectionId,
    );
    await insert(
      "INSERT INTO gateway_routes (id, service_principal_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      routeId,
      serviceId,
      "active",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      accountId,
      connectionId,
      "active",
      timestamp,
      timestamp,
    );

    await expect(resolveActiveIngressBindings(db, routeId, tenantId, [accountId]))
      .resolves.toMatchObject({ ok: true, value: [{ account_id: accountId, gateway_route_id: routeId }] });
  });

  it("enforces immutable ownership and terminal lifecycle transitions while preserving replay evidence", async () => {
    const seeded = await seedRouting("immutable_history");
    const replacementTimestamp = "2026-08-30T00:00:00.000Z";

    const forbiddenUpdates = [
      ["UPDATE gateway_routes SET id = ? WHERE id = ?", "gateway_route_replaced", seeded.routeId],
      ["UPDATE gateway_routes SET service_principal_id = ? WHERE id = ?", "principal_service_other", seeded.routeId],
      ["UPDATE connection_accounts SET account_id = ? WHERE account_id = ?", "account_replaced", seeded.accountId],
      ["UPDATE connection_accounts SET connection_id = ? WHERE account_id = ?", "connection_replaced", seeded.accountId],
      ["UPDATE connections SET tenant_id = ? WHERE id = ?", "tenant_other", seeded.connectionId],
      ["UPDATE connections SET identity_id = ? WHERE id = ?", "identity_other", seeded.connectionId],
      ["UPDATE connections SET provider = ? WHERE id = ?", "telegram", seeded.connectionId],
      ["UPDATE principals SET issuer = ? WHERE id = ?", "https://other.example/", seeded.serviceId],
      ["UPDATE principals SET subject = ? WHERE id = ?", "subject_replaced", seeded.serviceId],
      ["UPDATE principals SET principal_type = ? WHERE id = ?", "agent", seeded.serviceId],
      ["UPDATE connection_routes SET connection_id = ? WHERE connection_id = ?", "connection_replaced", seeded.connectionId],
      ["UPDATE connection_routes SET gateway_route_id = ? WHERE connection_id = ?", "gateway_route_replaced", seeded.connectionId],
    ] as const;
    for (const [sql, first, second] of forbiddenUpdates) {
      await expect(insert(sql, first, second)).rejects.toThrow();
    }
    await expect(insert("DELETE FROM gateway_routes WHERE id = ?", seeded.routeId)).rejects.toThrow();
    await expect(insert("DELETE FROM connection_accounts WHERE account_id = ?", seeded.accountId)).rejects.toThrow();
    await expect(insert("DELETE FROM connection_routes WHERE connection_id = ?", seeded.connectionId)).rejects.toThrow();

    await insert(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
      replacementTimestamp,
      seeded.serviceId,
    );
    await expect(insert("UPDATE principals SET status = 'active' WHERE id = ?", seeded.serviceId)).rejects.toThrow();
    await expect(insert("UPDATE principals SET revoked_at = ? WHERE id = ?", timestamp, seeded.serviceId)).rejects.toThrow();
    await expect(insert("UPDATE principals SET revoked_at = NULL WHERE id = ?", seeded.serviceId)).rejects.toThrow();
    await expect(findActiveIngestionService(db, issuer, "subject_immutable_history", "jti_replay"))
      .resolves.toEqual({ ok: false, code: "not_found" });

    await insert(
      "UPDATE gateway_routes SET status = 'revoked', revoked_at = ? WHERE id = ?",
      replacementTimestamp,
      seeded.routeId,
    );
    await expect(insert("UPDATE gateway_routes SET status = 'active', revoked_at = NULL WHERE id = ?", seeded.routeId)).rejects.toThrow();
    await insert(
      "UPDATE connection_accounts SET status = 'retired', retired_at = ? WHERE account_id = ?",
      replacementTimestamp,
      seeded.accountId,
    );
    await expect(insert("UPDATE connection_accounts SET status = 'active', retired_at = NULL WHERE account_id = ?", seeded.accountId)).rejects.toThrow();

    await insert(
      "INSERT INTO revoked_tokens (issuer, token_id, principal_id, reason, revoked_at) VALUES (?, ?, ?, ?, ?)",
      issuer,
      "jti_replay",
      seeded.serviceId,
      "replay review",
      replacementTimestamp,
    );
    await expect(insert("UPDATE revoked_tokens SET reason = ? WHERE issuer = ? AND token_id = ?", "changed", issuer, "jti_replay")).rejects.toThrow();
    await expect(insert("DELETE FROM revoked_tokens WHERE issuer = ? AND token_id = ?", issuer, "jti_replay")).rejects.toThrow();
    await expect(findActiveIngestionService(db, issuer, "subject_immutable_history", "jti_replay"))
      .resolves.toEqual({ ok: false, code: "not_found" });

    await expect(resolveArchivedIngestionRoute(db, seeded.routeId)).resolves.toEqual({
      ok: true,
      value: { gateway_route_id: seeded.routeId, service_principal_id: seeded.serviceId },
    });
    await expect(resolveArchivedBindings(db, seeded.routeId, seeded.tenantId, [seeded.accountId]))
      .resolves.toMatchObject({
        ok: true,
        value: [{
          account_id: seeded.accountId,
          connection_id: seeded.connectionId,
          identity_id: seeded.identityId,
          platform: "whatsapp",
          gateway_route_id: seeded.routeId,
          account_status: "retired",
        }],
      });
  });

  it("rejects UPDATE OR REPLACE from an unregistered legacy row into a registered connection", async () => {
    const registered = await seedRouting("update_replace_registered");
    const legacyConnectionId = "connection_update_replace_legacy";
    await insert(
      "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      legacyConnectionId,
      registered.tenantId,
      registered.identityId,
      "telegram",
      "Legacy",
      "ready",
      timestamp,
      timestamp,
    );
    await insert(
      "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      legacyConnectionId,
      "gateway-legacy-update-replace",
      "bridge-legacy",
      "matrix-user-legacy",
      "room-legacy",
      timestamp,
      timestamp,
    );

    const recursiveTriggers = await db.prepare("PRAGMA recursive_triggers").first<{ recursive_triggers: number }>();
    expect(recursiveTriggers?.recursive_triggers).toBe(0);
    const beforeRoutes = (await db.prepare(
      "SELECT connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at FROM connection_routes WHERE connection_id IN (?, ?) ORDER BY connection_id",
    ).bind(legacyConnectionId, registered.connectionId).all()).results;
    const beforeAccounts = (await db.prepare(
      "SELECT account_id, connection_id, status, created_at, updated_at, retired_at FROM connection_accounts WHERE account_id = ?",
    ).bind(registered.accountId).all()).results;

    await expect(insert(
      "UPDATE OR REPLACE connection_routes SET connection_id = ? WHERE connection_id = ?",
      registered.connectionId,
      legacyConnectionId,
    )).rejects.toThrow();

    await expect(db.prepare(
      "SELECT connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at FROM connection_routes WHERE connection_id IN (?, ?) ORDER BY connection_id",
    ).bind(legacyConnectionId, registered.connectionId).all()).resolves.toMatchObject({ results: beforeRoutes });
    await expect(db.prepare(
      "SELECT account_id, connection_id, status, created_at, updated_at, retired_at FROM connection_accounts WHERE account_id = ?",
    ).bind(registered.accountId).all()).resolves.toMatchObject({ results: beforeAccounts });
    await expect(resolveActiveIngressBindings(db, registered.routeId, registered.tenantId, [registered.accountId]))
      .resolves.toMatchObject({
        ok: true,
        value: [{ account_id: registered.accountId, connection_id: registered.connectionId }],
      });
  });

  it("rejects an unbounded account request before SQL and sanitizes binding failures", async () => {
    const tooMany = Array.from({ length: 501 }, (_, index) => `account_${index}`);
    const observingDb = {
      withSession() {
        throw new Error("query should not run");
      },
    } as unknown as D1Database;
    await expect(resolveActiveIngressBindings(observingDb, "gateway_route_one", "tenant_one", tooMany))
      .resolves.toEqual({ ok: false, code: "not_found" });

    const failureDb = {
      withSession: () => ({
        prepare: () => {
          throw new Error("sensitive SQL details");
        },
      }),
    } as unknown as D1Database;
    await expect(resolveActiveIngressBindings(failureDb, "gateway_route_one", "tenant_one", ["account_one"]))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(resolveArchivedBindings(failureDb, "gateway_route_one", "tenant_one", ["account_one"]))
      .resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("resolves a bounded request across query chunks and preserves UTF-8 account ordering", async () => {
    const seeded = await seedRouting("chunked_bindings");
    const count = 51;
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const connectionId = `connection_chunked_${suffix}`;
      const accountId = `account_chunked_${suffix}`;
      statements.push(
        db.prepare(
          "INSERT INTO connections (id, tenant_id, identity_id, provider, display_label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(connectionId, seeded.tenantId, seeded.identityId, "whatsapp", "WhatsApp", "ready", timestamp, timestamp),
        db.prepare(
          "INSERT INTO connection_routes (connection_id, gateway_route_id, bridge_instance_id, matrix_user_id, matrix_room_namespace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(connectionId, seeded.routeId, `bridge_chunked_${suffix}`, `matrix_user_chunked_${suffix}`, `room_chunked_${suffix}`, timestamp, timestamp),
        db.prepare(
          "INSERT INTO connection_accounts (account_id, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(accountId, connectionId, "active", timestamp, timestamp),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 120) {
      await db.batch(statements.slice(offset, offset + 120));
    }

    const accountIds = Array.from({ length: count }, (_, index) =>
      `account_chunked_${String(count - index - 1).padStart(3, "0")}`,
    );
    const result = await resolveActiveIngressBindings(db, seeded.routeId, seeded.tenantId, accountIds);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(count);
      expect(result.value.map((binding) => binding.account_id)).toEqual(
        Array.from({ length: count }, (_, index) => `account_chunked_${String(index).padStart(3, "0")}`),
      );
    }
  });

  it("observes a revocation or disablement committed immediately before a lookup", async () => {
    const seeded = await seedRouting("immediate_revocation");
    await insert("UPDATE gateway_routes SET status = 'disabled' WHERE id = ?", seeded.routeId);
    await expect(resolveActiveIngestionRoute(db, seeded.serviceId, seeded.routeId))
      .resolves.toEqual({ ok: false, code: "not_found" });
    await insert(
      "UPDATE principals SET status = 'revoked', revoked_at = ? WHERE id = ?",
      timestamp,
      seeded.serviceId,
    );
    await expect(findActiveIngestionService(db, issuer, "subject_immediate_revocation", "jti_immediate"))
      .resolves.toEqual({ ok: false, code: "not_found" });
  });
});
