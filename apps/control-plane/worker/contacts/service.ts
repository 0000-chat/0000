import {
  ContactCandidateSchema,
  ContactResolutionSchema,
  ContactSearchPageSchema,
  ContactSearchRequestSchema,
  ContactResolveRequestSchema,
  CreateDirectChatRequestSchema,
  DirectChatSchema,
  type ContactCandidate,
  type ContactMatchReason,
  type ContactResolution,
  type ContactSearchPage,
  type ContactSearchRequest,
  type ContactResolveRequest,
  type CreateDirectChatRequest,
  type DirectChat,
  type SessionResponse,
} from "@communicator/contracts";
import { hasAccountOperationGrantForAccount } from "../control-directory/grants";
import { ReadError } from "../read/errors";
import { isAdministratorSession } from "../read/authorization";
import type { OutboundCapability } from "../outbound/authority-types";
import { reservePrivateAuthority } from "../outbound/private-authority";
import {
  beginDirectChatOperation,
  directChatResult,
  finishDirectChatOperation,
  getContactCandidate,
  readContactRoute,
  readCreatedChatForContact,
  type ContactRouteRow,
  upsertContactCandidate,
} from "./repository";
import {
  ContactProviderError,
  defaultContactProvider,
  type ContactProvider,
  type ProviderContact,
  type ProviderDirectChat,
} from "./provider";

export type ContactServiceContext = {
  env: Cloudflare.Env;
  authorization: SessionResponse;
  delegated?: boolean;
};

export type ContactRouteServices = {
  createProvider?: (context: ContactServiceContext) => ContactProvider;
  now?: () => Date;
};

const usableStatuses = new Set(["connected", "syncing", "ready"]);

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const nowFor = (services: ContactRouteServices): string =>
  (services.now?.() ?? new Date()).toISOString();

const databaseFor = (context: ContactServiceContext): D1Database => {
  const database = context.env.CONTROL_DB;
  if (database === undefined || typeof database.withSession !== "function")
    throw new ReadError("service_unavailable");
  return database;
};

const requireIdentityScope = (
  session: SessionResponse,
  identityId: string,
  scope: "conversation.read" | "conversation.create",
): void => {
  const identity = session.identities.find(
    (candidate) => candidate.identity_id === identityId,
  );
  if (identity === undefined || !identity.scopes.includes(scope))
    throw new ReadError("forbidden");
};

const normalizePhone = (input: string): string => {
  const value = input.trim();
  const digits = value.startsWith("+") ? value.slice(1) : value;
  if (!/^\d{7,15}$/u.test(digits) || digits.startsWith("0"))
    throw new ReadError("invalid_request");
  return `+${digits}`;
};

const phoneFromIdentifiers = (
  identifiers: readonly string[],
): string | null => {
  for (const identifier of identifiers) {
    const value = identifier.startsWith("tel:")
      ? identifier.slice("tel:".length)
      : identifier;
    const digits = value.startsWith("+") ? value.slice(1) : value;
    if (/^\d{7,15}$/u.test(digits) && !digits.startsWith("0"))
      return `+${digits}`;
  }
  return null;
};

const stableKeyFor = (contact: ProviderContact): string =>
  phoneFromIdentifiers(contact.identifiers) ?? contact.provider_id;

const routeFor = (
  row: ContactRouteRow,
): ContactRouteRow & { provider: "whatsapp"; provider_login_id: string } => {
  if (row.provider !== "whatsapp") throw new ReadError("invalid_request");
  if (!usableStatuses.has(row.connection_status))
    throw new ReadError("service_unavailable");
  if (row.has_provider_identity !== 1)
    throw new ReadError("service_unavailable");
  if (row.provider_login_id === null || row.provider_login_id.length === 0)
    throw new ReadError("service_unavailable");
  if (row.has_contact_capability !== 1)
    throw new ReadError("service_unavailable");
  return {
    ...row,
    provider: "whatsapp",
    provider_login_id: row.provider_login_id,
  };
};

const routeInput = (
  row: ContactRouteRow & { provider: "whatsapp"; provider_login_id: string },
) => ({
  tenant_id: row.tenant_id,
  identity_id: row.identity_id,
  account_id: row.account_id,
  connection_id: row.connection_id,
  provider: row.provider as "whatsapp",
  session_generation: row.session_generation,
  gateway_route_id: row.gateway_route_id,
  bridge_instance_id: row.bridge_instance_id,
  matrix_user_id: row.matrix_user_id,
  matrix_room_namespace: row.matrix_room_namespace,
  provider_login_id: row.provider_login_id,
});

const providerFor = (
  context: ContactServiceContext,
  services: ContactRouteServices,
): ContactProvider =>
  services.createProvider?.(context) ?? defaultContactProvider(context.env);

const publicCandidate = async (
  route: ContactRouteRow,
  identityId: string,
  contact: ProviderContact,
  reason: ContactMatchReason,
): Promise<{ candidate: ContactCandidate; stableKey: string }> => {
  const stableKey = stableKeyFor(contact);
  const contactId = `contact_${(
    await sha256Hex(
      [route.tenant_id, route.account_id, route.provider, stableKey].join(
        "\u001f",
      ),
    )
  ).slice(0, 40)}`;
  const candidateRevision = await sha256Hex(
    JSON.stringify({
      provider_id: contact.provider_id,
      current_lid: contact.current_lid,
      stable_key: stableKey,
      display_name: contact.display_name,
      identifiers: [...contact.identifiers].sort(),
    }),
  );
  return {
    stableKey,
    candidate: ContactCandidateSchema.parse({
      contact_id: contactId,
      tenant_id: route.tenant_id,
      identity_id: identityId,
      account_id: route.account_id,
      connection_id: route.connection_id,
      provider: route.provider,
      provider_id: contact.provider_id,
      current_lid: contact.current_lid,
      display_name: contact.display_name,
      identifiers: contact.identifiers,
      match_reason: reason,
      candidate_revision: candidateRevision,
      observed_at: contact.evidence.observed_at,
      evidence: contact.evidence,
    }),
  };
};

const providerInput = (
  route: ContactRouteRow & { provider: "whatsapp"; provider_login_id: string },
  operationId: string,
  idempotencyKey: string,
) => ({
  route: routeInput(route),
  operation_id: operationId,
  idempotency_key: idempotencyKey,
});

const mapProviderError = (error: unknown): ReadError => {
  if (!(error instanceof ContactProviderError))
    return new ReadError("service_unavailable", error);
  if (error.code === "unresolved") return new ReadError("not_found", error);
  if (error.code === "rejected") return new ReadError("invalid_request", error);
  return new ReadError("service_unavailable", error);
};

const accountReadAuthorized = async (
  context: ContactServiceContext,
  identityId: string,
  accountId: string,
): Promise<void> => {
  const database = databaseFor(context);
  const granted = await hasAccountOperationGrantForAccount(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    context.authorization.membership.id,
    identityId,
    accountId,
    "conversation.read",
  );
  if (!granted && !isAdministratorSession(context.authorization))
    throw new ReadError("forbidden");
};

const readContactCapability = async (
  context: ContactServiceContext,
  route: ContactRouteRow & { provider: "whatsapp"; provider_login_id: string },
  identityId: string,
  accountId: string,
  conversationId: string,
): Promise<OutboundCapability | null> => {
  const db = databaseFor(context).withSession("first-primary");
  if (isAdministratorSession(context.authorization)) {
    const row = await db
      .prepare(
        `SELECT m.authority_epoch
           FROM memberships AS m
           JOIN tenants AS t ON t.id = m.tenant_id
           JOIN principals AS p ON p.id = m.principal_id
           JOIN identities AS i
             ON i.tenant_id = m.tenant_id AND i.id = ?
           JOIN connections AS c
             ON c.tenant_id = m.tenant_id AND c.id = ?
            AND c.identity_id = i.id
           JOIN connection_accounts AS ca
             ON ca.connection_id = c.id AND ca.account_id = ?
            AND ca.status = 'active'
          WHERE m.tenant_id = ? AND m.id = ?
            AND t.status = 'active'
            AND m.status = 'active' AND m.role IN ('owner', 'admin')
            AND p.status = 'active' AND p.revoked_at IS NULL
            AND p.principal_type IN ('human', 'operator')
            AND i.status = 'active' AND i.identity_kind = 'human'
          LIMIT 1`,
      )
      .bind(
        identityId,
        route.connection_id,
        accountId,
        context.authorization.tenant.id,
        context.authorization.membership.id,
      )
      .first<{ authority_epoch: number }>();
    return row === null
      ? null
      : {
          kind: "owner_admin",
          authority_id: context.authorization.membership.id,
          authority_epoch: row.authority_epoch,
        };
  }
  const row = await db
    .prepare(
      `SELECT g.id AS grant_id, g.authorization_epoch
         FROM account_grants AS g
         JOIN identity_grants AS ig
           ON ig.tenant_id = g.tenant_id
          AND ig.membership_id = g.membership_id
          AND ig.identity_id = g.identity_id
          AND ig.operation_scope = 'conversation.create'
         JOIN connection_accounts AS ca
           ON ca.account_id = g.account_id AND ca.status = 'active'
         JOIN connections AS c
           ON c.tenant_id = g.tenant_id AND c.id = ca.connection_id AND c.id = ?
        WHERE g.tenant_id = ? AND g.membership_id = ? AND g.identity_id = ?
          AND g.account_id = ? AND g.operation_scope = 'conversation.create'
          AND g.status = 'active'
          AND (g.chat_scope = 'all_chats' OR EXISTS (
            SELECT 1 FROM account_grant_chats AS gc
             WHERE gc.tenant_id = g.tenant_id AND gc.grant_id = g.id
               AND gc.account_id = g.account_id AND gc.chat_id = ?
          ))
        ORDER BY g.id LIMIT 1`,
    )
    .bind(
      route.connection_id,
      context.authorization.tenant.id,
      context.authorization.membership.id,
      identityId,
      accountId,
      conversationId,
    )
    .first<{ grant_id: string; authorization_epoch: number }>();
  return row === null
    ? null
    : {
        kind: "account_grant",
        grant_id: row.grant_id,
        authorization_epoch: row.authorization_epoch,
      };
};

const ensureRoute = async (
  context: ContactServiceContext,
  identityId: string,
  accountId: string,
): Promise<
  ContactRouteRow & { provider: "whatsapp"; provider_login_id: string }
> => {
  const route = await readContactRoute(
    databaseFor(context).withSession("first-primary"),
    context.authorization.tenant.id,
    identityId,
    accountId,
  );
  if (route === null) throw new ReadError("not_found");
  return routeFor(route);
};

export async function searchContacts(
  context: ContactServiceContext,
  input: ContactSearchRequest,
  services: ContactRouteServices = {},
): Promise<ContactSearchPage> {
  const parsed = ContactSearchRequestSchema.parse(input);
  requireIdentityScope(
    context.authorization,
    parsed.identity_id,
    "conversation.read",
  );
  await accountReadAuthorized(context, parsed.identity_id, parsed.account_id);
  const route = await ensureRoute(
    context,
    parsed.identity_id,
    parsed.account_id,
  );
  const operationId = `contact_search_${crypto.randomUUID().replaceAll("-", "")}`;
  let contacts: ProviderContact[];
  try {
    contacts = await providerFor(context, services).search(
      providerInput(route, operationId, operationId),
      parsed.query,
    );
  } catch (error) {
    throw mapProviderError(error);
  }
  const database = databaseFor(context);
  const now = nowFor(services);
  const candidates: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    const mapped = await publicCandidate(
      route,
      parsed.identity_id,
      contact,
      "name",
    );
    if (seen.has(mapped.candidate.contact_id)) continue;
    seen.add(mapped.candidate.contact_id);
    await upsertContactCandidate(database, {
      candidate: mapped.candidate,
      stableKey: mapped.stableKey,
      now,
    });
    candidates.push(mapped.candidate);
  }
  return ContactSearchPageSchema.parse({
    items: candidates,
    next_cursor: null,
  });
}

export async function resolveContact(
  context: ContactServiceContext,
  input: ContactResolveRequest,
  services: ContactRouteServices = {},
): Promise<ContactResolution> {
  const parsed = ContactResolveRequestSchema.parse(input);
  requireIdentityScope(
    context.authorization,
    parsed.identity_id,
    "conversation.read",
  );
  await accountReadAuthorized(context, parsed.identity_id, parsed.account_id);
  const phone = normalizePhone(parsed.phone);
  const route = await ensureRoute(
    context,
    parsed.identity_id,
    parsed.account_id,
  );
  const operationId = `contact_resolve_${crypto.randomUUID().replaceAll("-", "")}`;
  let contact: ProviderContact;
  try {
    contact = await providerFor(context, services).resolve(
      providerInput(route, operationId, operationId),
      phone,
    );
  } catch (error) {
    if (error instanceof ContactProviderError && error.code === "unsupported")
      return ContactResolutionSchema.parse({
        status: "unsupported",
        candidate: null,
        reason: "provider_contact_resolution_unsupported",
      });
    if (error instanceof ContactProviderError && error.code === "unresolved")
      return ContactResolutionSchema.parse({
        status: "unresolved",
        candidate: null,
        reason: "phone_number_unresolved",
      });
    throw mapProviderError(error);
  }
  const database = databaseFor(context);
  const mapped = await publicCandidate(
    route,
    parsed.identity_id,
    contact,
    "phone",
  );
  await upsertContactCandidate(database, {
    candidate: mapped.candidate,
    stableKey: mapped.stableKey,
    now: nowFor(services),
  });
  return ContactResolutionSchema.parse({
    status: "resolved",
    candidate: mapped.candidate,
    reason: null,
  });
}

export async function createDirectChat(
  context: ContactServiceContext,
  input: CreateDirectChatRequest,
  services: ContactRouteServices = {},
): Promise<DirectChat> {
  const parsed = CreateDirectChatRequestSchema.parse(input);
  requireIdentityScope(
    context.authorization,
    parsed.identity_id,
    "conversation.create",
  );
  const database = databaseFor(context);
  const candidate = await getContactCandidate(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    parsed.account_id,
    parsed.contact_id,
  );
  if (candidate === null) throw new ReadError("not_found");
  if (candidate.candidate_revision !== parsed.candidate_revision)
    throw new ReadError("invalid_request");
  if (candidate.identity_id !== parsed.identity_id)
    throw new ReadError("forbidden");
  const route = await ensureRoute(
    context,
    parsed.identity_id,
    parsed.account_id,
  );
  const conversationId = `conversation_${(
    await sha256Hex(
      [
        context.authorization.tenant.id,
        parsed.account_id,
        parsed.contact_id,
      ].join("\u001f"),
    )
  ).slice(0, 40)}`;
  const capability = await readContactCapability(
    context,
    route,
    parsed.identity_id,
    parsed.account_id,
    conversationId,
  );
  if (capability === null) throw new ReadError("forbidden");

  const existingChat = await readCreatedChatForContact(
    database.withSession("first-primary"),
    context.authorization.tenant.id,
    parsed.account_id,
    parsed.contact_id,
  );
  if (existingChat !== null) return directChatResult(existingChat);

  const operationId = `chat_create_${crypto.randomUUID().replaceAll("-", "")}`;
  const requestHash = await sha256Hex(JSON.stringify(parsed));
  let resolved: ProviderContact;
  try {
    resolved = await providerFor(context, services).resolve(
      providerInput(route, operationId, parsed.idempotency_key),
      candidate.provider_id,
    );
  } catch (error) {
    throw mapProviderError(error);
  }
  const refreshed = await publicCandidate(
    route,
    parsed.identity_id,
    resolved,
    "provider_id",
  );
  if (
    refreshed.stableKey !==
    stableKeyFor({
      provider_id: candidate.provider_id,
      current_lid: candidate.current_lid,
      display_name: candidate.display_name,
      identifiers: candidate.identifiers,
      evidence: candidate.evidence,
    })
  ) {
    throw new ReadError("invalid_request");
  }
  await upsertContactCandidate(database, {
    candidate: {
      ...refreshed.candidate,
      contact_id: candidate.contact_id,
      identity_id: parsed.identity_id,
      match_reason: candidate.match_reason,
    },
    stableKey: refreshed.stableKey,
    now: nowFor(services),
  });
  const begun = await beginDirectChatOperation(database, {
    operationId,
    tenantId: context.authorization.tenant.id,
    identityId: parsed.identity_id,
    accountId: parsed.account_id,
    connectionId: route.connection_id,
    membershipId: context.authorization.membership.id,
    provider: route.provider,
    contactId: candidate.contact_id,
    candidateRevision: refreshed.candidate.candidate_revision,
    conversationId,
    idempotencyKey: parsed.idempotency_key,
    requestHash,
    sessionGeneration: route.session_generation,
    providerId: refreshed.candidate.provider_id,
    currentLid: refreshed.candidate.current_lid,
    now: nowFor(services),
  });
  const operation = begun.operation;
  if (operation.status === "created" || operation.status === "already_exists")
    return directChatResult(operation);
  if (!begun.dispatchOwner) throw new ReadError("service_unavailable");
  if (operation.status !== "pending")
    throw new ReadError("service_unavailable");

  const reservation = await reservePrivateAuthority(
    database.withSession("first-primary"),
    {
      tenant_id: operation.tenantId,
      membership_id: operation.membershipId,
      identity_id: operation.identityId,
      account_id: operation.accountId,
      conversation_id: operation.conversationId,
      connection_id: operation.connectionId,
      operation_scope: "conversation.create",
      operation_id: operation.operationId,
      request_hash: operation.requestHash,
      session_generation: route.session_generation,
      capability,
      now: nowFor(services),
    },
  );
  if (reservation.status === "denied") {
    await finishDirectChatOperation(
      database,
      operation,
      { status: "failed", failureCode: "authorization_revoked" },
      nowFor(services),
    );
    throw new ReadError(
      reservation.reason === "authorization_revoked"
        ? "forbidden"
        : "service_unavailable",
    );
  }

  let created: ProviderDirectChat;
  try {
    created = await providerFor(context, services).createDirectChat(
      {
        ...providerInput(route, operation.operationId, parsed.idempotency_key),
        membership_id: reservation.reservation.membership_id,
        actor_identity_id: reservation.reservation.identity_id,
        reservation_id: reservation.reservation.id,
        capability: reservation.reservation.capability,
        request_hash: reservation.reservation.request_hash,
        operation_scope: "conversation.create",
      },
      refreshed.candidate.provider_id,
      conversationId,
    );
  } catch (error) {
    const providerError =
      error instanceof ContactProviderError
        ? error
        : new ContactProviderError("unavailable");
    const terminal =
      providerError.code === "rejected" || providerError.code === "unresolved";
    await finishDirectChatOperation(
      database,
      operation,
      terminal
        ? { status: "failed", failureCode: `provider_${providerError.code}` }
        : {
            status: "uncertain",
            failureCode: `provider_${providerError.code}`,
          },
      nowFor(services),
    );
    throw mapProviderError(providerError);
  }
  const sameStableKey = stableKeyFor(created) === refreshed.stableKey;
  const sameProviderId =
    created.provider_id.trim().length > 0 &&
    refreshed.candidate.provider_id.trim().length > 0 &&
    created.provider_id === refreshed.candidate.provider_id;
  const sameLid =
    created.current_lid !== null &&
    created.current_lid.trim().length > 0 &&
    refreshed.candidate.current_lid !== null &&
    refreshed.candidate.current_lid.trim().length > 0 &&
    created.current_lid === refreshed.candidate.current_lid;
  if (!sameStableKey && !sameProviderId && !sameLid) {
    await finishDirectChatOperation(
      database,
      operation,
      { status: "failed", failureCode: "provider_recipient_mismatch" },
      nowFor(services),
    );
    throw new ReadError("invalid_request");
  }
  await upsertContactCandidate(database, {
    candidate: {
      ...refreshed.candidate,
      provider_id: created.provider_id,
      current_lid: created.current_lid,
      evidence: created.evidence,
    },
    stableKey: refreshed.stableKey,
    now: nowFor(services),
  });
  const finished = await finishDirectChatOperation(
    database,
    operation,
    {
      status: created.status,
      providerId: created.provider_id,
      currentLid: created.current_lid,
      matrixRoomId: created.matrix_room_id,
      evidence: created.evidence,
    },
    nowFor(services),
  );
  const final = directChatResult(finished);
  return DirectChatSchema.parse(final);
}
