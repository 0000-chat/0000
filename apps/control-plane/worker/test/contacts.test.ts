import { env as runtimeEnv } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ContactEvidenceOperation,
  type ContactProviderEvidence,
} from "@communicator/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import type { VerifiedSubject } from "../auth/oidc";
import {
  ContactProviderError,
  type ContactProvider,
  type ProviderContact,
  type ProviderDirectChat,
  type ContactProviderInput,
} from "../contacts/provider";
import {
  clearDirectory,
  seedAccountAccess,
  seedDirectory,
} from "./support/directory-fixtures";

const env = runtimeEnv as typeof runtimeEnv & { CONTROL_DB: D1Database };
const tenantId = "tenant_pilot";
const observedAt = "2026-09-14T00:00:00.000Z";

type ProviderState = {
  searchCalls: ContactProviderInput[];
  resolveCalls: ContactProviderInput[];
  createCalls: ContactProviderInput[];
  createAttempts: number;
  timeoutCreates: boolean;
  mismatchCreate?: boolean;
  blockCreate?: boolean;
  createStarted?: () => void;
  releaseCreate?: Promise<void>;
};

const evidence = (
  operation: ContactEvidenceOperation,
  providerId: string,
  status: "confirmed" | "already_exists" | "uncertain" = "confirmed",
  matrixRoomId: string | null = null,
): ContactProviderEvidence => ({
  source: "provider",
  operation,
  evidence_id: "evidence_" + operation + "_" + providerId.replaceAll("@", "_"),
  observed_at: observedAt,
  provider_id: providerId,
  matrix_room_id: matrixRoomId,
  status,
  reason: null,
});

const contact = (
  providerId: string,
  phone: string,
  lid: string,
  name: string,
  operation: ContactEvidenceOperation = "search",
): ProviderContact => ({
  provider_id: providerId,
  current_lid: lid,
  display_name: name,
  identifiers: [phone, lid],
  evidence: evidence(operation, providerId),
});

const providerFor = (state: ProviderState): ContactProvider => ({
  async search(input, query) {
    state.searchCalls.push(input);
    expect(query).toBe("Alex");
    return [
      contact("contact_alex_one", "+15550000001", "alex-one@lid", "Alex"),
      contact("contact_alex_two", "+15550000002", "alex-two@lid", "Alex"),
    ];
  },
  async resolve(input, identifier) {
    state.resolveCalls.push(input);
    if (identifier === "+15550000001" || identifier === "contact_alex_one") {
      return contact(
        "contact_alex_one",
        "+15550000001",
        "alex-new@lid",
        "Alex",
        "resolve",
      );
    }
    if (identifier === "+15550000003" || identifier === "contact_timeout") {
      return contact(
        "contact_timeout",
        "+15550000003",
        "timeout@lid",
        "Timeout",
        "resolve",
      );
    }
    throw new ContactProviderError("unresolved");
  },
  async createDirectChat(
    input,
    providerId,
    conversationId,
  ): Promise<ProviderDirectChat> {
    state.createCalls.push(input);
    state.createAttempts += 1;
    if (state.createStarted !== undefined) state.createStarted();
    if (state.blockCreate && state.releaseCreate !== undefined)
      await state.releaseCreate;
    if (state.timeoutCreates || providerId === "contact_timeout")
      throw new ContactProviderError("unavailable");
    if (state.mismatchCreate) {
      return {
        provider_id: "contact_other",
        current_lid: null,
        display_name: "Other",
        identifiers: ["+15550000099"],
        matrix_room_id: "!contact-other:example.test",
        status: "created",
        evidence: evidence(
          "create_dm",
          "contact_other",
          "confirmed",
          "!contact-other:example.test",
        ),
      };
    }
    return {
      ...contact(
        providerId,
        "+15550000001",
        "alex-new@lid",
        "Alex",
        "create_dm",
      ),
      matrix_room_id: "!contact-alex-one:example.test",
      status:
        conversationId === "conversation_existing"
          ? "already_exists"
          : "created",
      evidence: evidence(
        "create_dm",
        providerId,
        conversationId === "conversation_existing"
          ? "already_exists"
          : "confirmed",
        "!contact-alex-one:example.test",
      ),
    };
  },
});

const createTestApp = (state: ProviderState) =>
  createApp({
    createTokenVerifier: () => ({
      verify: async (token: string): Promise<VerifiedSubject> => {
        if (token === "human-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "human-subject",
          };
        }
        if (token === "agent-token") {
          return {
            issuer: "https://issuer.example/",
            subject: "agent-subject",
            token_id: "agent-token-id",
          };
        }
        throw new Error("invalid local token");
      },
    }),
    contactServices: {
      createProvider: () => providerFor(state),
    },
  });

const request = (
  app: ReturnType<typeof createTestApp>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(
    "http://example.test" + path,
    {
      ...init,
      headers: {
        Authorization: "Bearer human-token",
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    env,
  );

const createBody = (
  contactId: string,
  candidateRevision: string,
  idempotencyKey: string,
  accountId = "account_human",
) => ({
  identity_id: "identity_human",
  account_id: accountId,
  contact_id: contactId,
  candidate_revision: candidateRevision,
  idempotency_key: idempotencyKey,
});

async function seedContactDirectory(): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO provider_capability_records (tenant_id, account_id, connection_id, identity_id, provider, capability, status, freshness, proof_source, provider_evidence_json, product_claim, observed_at, updated_at) VALUES (?, ?, ?, ?, 'whatsapp', 'contact.lookup', 'supported', 'fresh', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "account_human",
      "connection_human_whatsapp",
      "identity_human",
      "contact-resolution-test",
      "{}",
      "Provider contact lookup is available",
      observedAt,
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO connection_provider_identities (tenant_id, provider, identity_key, provider_login_id, connection_id, link_session_id, created_at) VALUES (?, 'whatsapp', ?, ?, ?, ?, ?)",
    ).bind(
      tenantId,
      "c".repeat(64),
      "login-human",
      "connection_human_whatsapp",
      "link-contact-human",
      observedAt,
    ),
    env.CONTROL_DB.prepare(
      "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, ?, ?, 'conversation.create', ?)",
    ).bind(tenantId, "membership_human", "identity_human", observedAt),
    env.CONTROL_DB.prepare(
      "INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'conversation.create', 'all_chats', 'active', ?, ?)",
    ).bind(
      "grant_contact_create",
      tenantId,
      "membership_human",
      "identity_human",
      "account_human",
      observedAt,
      observedAt,
    ),
  ]);
}

async function connectMcp(
  app: ReturnType<typeof createTestApp>,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({
    name: "contact-resolution-test-client",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://example.test/mcp"),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer human-token",
          Origin: "http://example.test",
        },
      },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : input.toString();
        return app.request(url, init, env);
      },
    },
  );
  await client.connect(
    transport as unknown as Parameters<Client["connect"]>[0],
  );
  return { client, transport };
}

beforeEach(async () => {
  await clearDirectory(env.CONTROL_DB);
  await seedDirectory(env.CONTROL_DB);
  await seedAccountAccess(env.CONTROL_DB);
  await seedContactDirectory();
});

describe("contact resolution REST and MCP boundaries", () => {
  it("keeps name candidates distinct, refreshes LID, and routes MCP through the selected account", async () => {
    const state: ProviderState = {
      searchCalls: [],
      resolveCalls: [],
      createCalls: [],
      createAttempts: 0,
      timeoutCreates: false,
    };
    const app = createTestApp(state);
    const search = await request(
      app,
      "/api/v1/contacts?identity_id=identity_human&account_id=account_human&query=Alex",
    );
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(searchBody.items).toHaveLength(2);
    expect(searchBody.items.map((item) => item.display_name)).toEqual([
      "Alex",
      "Alex",
    ]);
    expect(searchBody.items.map((item) => item.match_reason)).toEqual([
      "name",
      "name",
    ]);
    expect(new Set(searchBody.items.map((item) => item.contact_id)).size).toBe(
      2,
    );
    expect(state.searchCalls[0]?.route.account_id).toBe("account_human");
    expect(state.searchCalls[0]?.route.provider_login_id).toBe("login-human");

    const resolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000001",
      }),
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as {
      status: string;
      candidate: {
        contact_id: string;
        current_lid: string;
        candidate_revision: string;
      };
    };
    expect(resolvedBody.status).toBe("resolved");
    expect(resolvedBody.candidate.current_lid).toBe("alex-new@lid");
    expect(resolvedBody.candidate.candidate_revision).toMatch(
      /^[0-9a-f]{64}$/u,
    );

    const mcp = await connectMcp(app);
    const mcpSearch = await mcp.client.callTool({
      name: "search_contacts",
      arguments: {
        identity_id: "identity_human",
        account_id: "account_human",
        query: "Alex",
      },
    });
    expect(mcpSearch.isError).not.toBe(true);
    expect(
      (mcpSearch.structuredContent as { items: unknown[] }).items,
    ).toHaveLength(2);
    await mcp.client.close();
    await mcp.transport.close();
  });

  it("rejects stale or mismatched candidates and requires the account create grant", async () => {
    const state: ProviderState = {
      searchCalls: [],
      resolveCalls: [],
      createCalls: [],
      createAttempts: 0,
      timeoutCreates: false,
    };
    const app = createTestApp(state);
    const resolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000001",
      }),
    });
    const resolvedBody = (await resolved.json()) as {
      candidate: {
        contact_id: string;
        candidate_revision: string;
      };
    };
    expect(resolved.status, JSON.stringify(resolvedBody)).toBe(200);
    const candidate = resolvedBody;
    const storedCandidate = await env.CONTROL_DB.prepare(
      "SELECT contact_id, account_id, identity_id FROM contact_resolution_candidates WHERE tenant_id = ? AND account_id = ?",
    )
      .bind(tenantId, "account_human")
      .all();
    expect(storedCandidate.results).toEqual([
      {
        contact_id: candidate.candidate.contact_id,
        account_id: "account_human",
        identity_id: "identity_human",
      },
    ]);
    const body = createBody(
      candidate.candidate.contact_id,
      candidate.candidate.candidate_revision,
      "create-alex-one",
    );

    const stale = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        candidate_revision: "0".repeat(64),
      }),
    });
    expect(stale.status).toBe(400);

    const mismatch = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        account_id: "account_agent",
      }),
    });
    expect(mismatch.status).toBe(404);

    await env.CONTROL_DB.prepare(
      "UPDATE account_grants SET status = 'revoked', revoked_at = ? WHERE id = ?",
    )
      .bind(observedAt, "grant_contact_create")
      .run();
    const revoked = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(revoked.status).toBe(403);
  });

  it("reports malformed and unresolved phones, provider timeout, and idempotent duplicate creation", async () => {
    const state: ProviderState = {
      searchCalls: [],
      resolveCalls: [],
      createCalls: [],
      createAttempts: 0,
      timeoutCreates: false,
    };
    const app = createTestApp(state);
    const malformed = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "not-a-phone",
      }),
    });
    expect(malformed.status).toBe(400);

    const unresolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000009",
      }),
    });
    expect(unresolved.status).toBe(200);
    expect(await unresolved.json()).toMatchObject({
      status: "unresolved",
      candidate: null,
    });

    const resolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000001",
      }),
    });
    const resolvedBody = await resolved.json();
    expect(resolved.status, JSON.stringify(resolvedBody)).toBe(200);
    const candidate = resolvedBody as {
      candidate: { contact_id: string; candidate_revision: string };
    };
    const candidateRow = await env.CONTROL_DB.prepare(
      "SELECT contact_id, tenant_id, identity_id, account_id, candidate_revision FROM contact_resolution_candidates WHERE tenant_id = ? AND account_id = ? AND contact_id = ?",
    )
      .bind(tenantId, "account_human", candidate.candidate.contact_id)
      .first();
    expect(candidateRow, JSON.stringify(resolvedBody)).not.toBeNull();
    const routeRow = await env.CONTROL_DB.prepare(
      "SELECT c.id AS connection_id, c.identity_id, ca.account_id, pi.provider_login_id FROM connections c JOIN connection_accounts ca ON ca.connection_id = c.id AND ca.status = 'active' LEFT JOIN connection_provider_identities pi ON pi.connection_id = c.id WHERE c.tenant_id = ? AND c.identity_id = ? AND ca.account_id = ?",
    )
      .bind(tenantId, "identity_human", "account_human")
      .first();
    expect(routeRow, JSON.stringify(resolvedBody)).not.toBeNull();
    const grantRow = await env.CONTROL_DB.prepare(
      "SELECT id, status, operation_scope, chat_scope FROM account_grants WHERE tenant_id = ? AND membership_id = ? AND identity_id = ? AND account_id = ? ORDER BY id",
    )
      .bind(tenantId, "membership_human", "identity_human", "account_human")
      .all();
    expect(grantRow.results, JSON.stringify(resolvedBody)).toEqual([
      {
        id: "grant_contact_create",
        status: "active",
        operation_scope: "conversation.create",
        chat_scope: "all_chats",
      },
      {
        id: "grant_fixture_human",
        status: "active",
        operation_scope: "conversation.read",
        chat_scope: "all_chats",
      },
    ]);
    const body = createBody(
      candidate.candidate.contact_id,
      candidate.candidate.candidate_revision,
      "create-alex-idempotent",
    );
    const created = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const createdBody = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(200);
    expect(createdBody).toMatchObject({
      status: "created",
      account_id: "account_human",
      connection_id: "connection_human_whatsapp",
    });
    const duplicate = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ status: "created" });
    expect(state.createAttempts).toBe(1);

    const timeoutResolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000003",
      }),
    });
    const timeoutCandidate = (await timeoutResolved.json()) as {
      candidate: { contact_id: string; candidate_revision: string };
    };
    const timeoutBody = createBody(
      timeoutCandidate.candidate.contact_id,
      timeoutCandidate.candidate.candidate_revision,
      "create-timeout",
    );
    const timeout = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(timeoutBody),
    });
    expect(timeout.status).toBe(503);
    const timeoutReplay = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(timeoutBody),
    });
    expect(timeoutReplay.status).toBe(503);
    expect(state.createAttempts).toBe(2);
    expect(
      state.createCalls.every(
        (input) => input.route.account_id === "account_human",
      ),
    ).toBe(true);
  });

  it("rejects a provider response for a different recipient and records the terminal failure", async () => {
    const state: ProviderState = {
      searchCalls: [],
      resolveCalls: [],
      createCalls: [],
      createAttempts: 0,
      timeoutCreates: false,
      mismatchCreate: true,
    };
    const app = createTestApp(state);
    const resolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000001",
      }),
    });
    const resolvedBody = (await resolved.json()) as {
      candidate: { contact_id: string; candidate_revision: string };
    };
    expect(resolved.status).toBe(200);
    const body = createBody(
      resolvedBody.candidate.contact_id,
      resolvedBody.candidate.candidate_revision,
      "create-recipient-mismatch",
    );
    const rejected = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(rejected.status).toBe(400);
    expect(state.createAttempts).toBe(1);

    const operation = await env.CONTROL_DB.prepare(
      "SELECT status, failure_code, matrix_room_id FROM direct_chat_creation_operations WHERE tenant_id = ? AND idempotency_key = ?",
    )
      .bind(tenantId, "create-recipient-mismatch")
      .first();
    expect(operation).toEqual({
      status: "failed",
      failure_code: "provider_recipient_mismatch",
      matrix_room_id: null,
    });
    const candidateRow = await env.CONTROL_DB.prepare(
      "SELECT provider_id, current_lid FROM contact_resolution_candidates WHERE tenant_id = ? AND contact_id = ?",
    )
      .bind(tenantId, resolvedBody.candidate.contact_id)
      .first();
    expect(candidateRow).toEqual({
      provider_id: "contact_alex_one",
      current_lid: "alex-new@lid",
    });
    const replay = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(503);
    expect(state.createAttempts).toBe(1);
  });

  it("allows only the fresh operation owner to dispatch while a duplicate is pending", async () => {
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    let releaseCreate!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const state: ProviderState = {
      searchCalls: [],
      resolveCalls: [],
      createCalls: [],
      createAttempts: 0,
      timeoutCreates: false,
      blockCreate: true,
      createStarted: markCreateStarted,
      releaseCreate: release,
    };
    const app = createTestApp(state);
    const resolved = await request(app, "/api/v1/contacts/resolve", {
      method: "POST",
      body: JSON.stringify({
        identity_id: "identity_human",
        account_id: "account_human",
        phone: "+15550000001",
      }),
    });
    const resolvedBody = (await resolved.json()) as {
      candidate: { contact_id: string; candidate_revision: string };
    };
    expect(resolved.status).toBe(200);
    const body = createBody(
      resolvedBody.candidate.contact_id,
      resolvedBody.candidate.candidate_revision,
      "create-pending-duplicate",
    );
    const firstRequest = request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await createStarted;

    const duplicate = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(503);
    expect(state.createAttempts).toBe(1);

    releaseCreate();
    const first = await firstRequest;
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "created",
      contact_id: resolvedBody.candidate.contact_id,
    });
    const replay = await request(app, "/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "created" });
    expect(state.createAttempts).toBe(1);
    const operationCount = await env.CONTROL_DB.prepare(
      "SELECT COUNT(*) AS count FROM direct_chat_creation_operations WHERE tenant_id = ? AND idempotency_key = ?",
    )
      .bind(tenantId, "create-pending-duplicate")
      .first<{ count: number }>();
    expect(operationCount?.count).toBe(1);
  });
});
