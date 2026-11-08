import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const tenant = "tenant_pilot";
const account = "account_human";
const conversation = "conversation_integrated";
const agentIdentity = "identity_agent";
const humanIdentity = "identity_human";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const messagePath = `/api/v1/conversations/${conversation}/messages`;
const metadataPath = (attachment, identity, ownerAccount) =>
  `/api/v1/attachments/${encodeURIComponent(attachment)}?${new URLSearchParams({ identity_id: identity, account_id: ownerAccount })}`;

/*
 * Required hooks, in addition to observe/api/getRuntime/gatewayReady:
 * humanApi: same JSON signature as api, authenticated with the real human
 *   Platform credential. Its issued capabilities must include connection.manage
 *   and conversation.read; local membership_human remains its seeded owner role.
 * rawApi: same arguments as api, authenticated with the managed-agent credential,
 *   but returns an unconsumed fetch Response, including for non-2xx statuses.
 * getGatewayStats: async () => parsed sidecar stats JSON (counts only).
 * gatewayReady is the parsed sidecar readiness object, not its filename.
 *
 * No grants, principal kinds, memberships, credentials, projection rows or
 * provider responses are fabricated here. History mutation is an administrator
 * operation in the actual route contract: the agent must remain denied, and the
 * existing human starts/advances the import. The agent's existing account-scoped
 * conversation.read grant already authorizes stored text and attachment reads;
 * there is no supported extra history.import or attachment.read local grant.
 * Run serially while the same sidecar remains alive, before destructive removal
 * cases. Never return download grants or response bodies in observation facts.
 */
export async function runHistoryProof({
  observe,
  api,
  getRuntime,
  gatewayReady,
  humanApi,
  rawApi,
  getGatewayStats,
}) {
  let initialEffects;
  let detail;
  let importedText;
  let attachment;
  let metadata;
  let database;
  const key = `integrated-history-${randomUUID()}`;
  const effects = async () => {
    const stats = await getGatewayStats();
    const receipts = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM receipt_operations WHERE tenant_id = ?",
      )
      .bind(tenant)
      .first();
    assert.ok(
      Number.isSafeInteger(stats.receipt_requests),
      "actual Matrix receipt counter required",
    );
    assert.ok(
      Number.isSafeInteger(stats.send_requests),
      "actual Matrix send counter required",
    );
    assert.ok(
      Number.isSafeInteger(receipts?.count),
      "receipt operation baseline required",
    );
    return {
      matrix_receipts: stats.receipt_requests,
      matrix_sends: stats.send_requests,
      receipt_operations: receipts.count,
    };
  };
  const startBody = (identity) => ({
    identity_id: identity,
    start_at: gatewayReady.history_start_at,
    end_at: gatewayReady.history_end_at,
    max_events: 100,
  });
  const requireImport = () => {
    assert.ok(
      detail?.import?.import_id,
      "successful real human history import prerequisite",
    );
  };

  await observe("history-supported-authority-preconditions", async () => {
    assert.equal(
      typeof humanApi,
      "function",
      "humanApi hook required; agent promotion is forbidden",
    );
    assert.equal(
      typeof rawApi,
      "function",
      "rawApi hook required for actual binary Worker download",
    );
    assert.equal(
      typeof getGatewayStats,
      "function",
      "getGatewayStats hook required for actual Matrix side effects",
    );
    assert.equal(gatewayReady.encrypted_history_fixture, true);
    assert.equal(gatewayReady.history_supported, true);
    assert.match(
      gatewayReady.controlled_expected_text_digest,
      /^[0-9a-f]{64}$/u,
    );
    assert.match(gatewayReady.file_digest, /^[0-9a-f]{64}$/u);
    assert.ok(
      Number.isSafeInteger(gatewayReady.file_size_bytes) &&
        gatewayReady.file_size_bytes > 0,
    );
    assert.ok(
      Date.parse(gatewayReady.history_start_at) <
        Date.parse(gatewayReady.history_end_at),
    );
    database = await getRuntime().getD1Database("CONTROL_DB", "communicator");
    const agent = await api("/api/v1/session");
    assert.equal(agent.status, 200);
    assert.equal(agent.body.principal.type, "agent");
    assert.equal(agent.body.principal.id, "principal_agent");
    assert.equal(agent.body.membership.id, "membership_agent");
    assert.equal(agent.body.membership.role, "member");
    const human = await humanApi("/api/v1/session");
    assert.equal(human.status, 200);
    assert.equal(human.body.principal.type, "human");
    assert.ok(["owner", "admin"].includes(human.body.membership.role));
    const identity = human.body.identities.find(
      (item) => item.identity_id === humanIdentity,
    );
    assert.ok(
      identity?.scopes.includes("connection.manage"),
      "human credential must actually carry connection.manage through Platform's capability ceiling",
    );
    initialEffects = await effects();
    return {
      authenticated_agent_type: "agent",
      agent_membership_role: "member",
      authenticated_human_administrator: true,
      human_connection_manage_verified: true,
      local_grant_mutations: 0,
      sdk_session_is_fixture: gatewayReady.matrix_session_fixture === true,
      actual_matrix_login: gatewayReady.actual_matrix_login === true,
      scope:
        "controlled encrypted Matrix history, not live bridge/provider history",
    };
  });

  await observe("history-agent-denied-without-promotion", async () => {
    assert.ok(initialEffects, "verified authority prerequisites required");
    const denied = await api(
      `/api/v1/accounts/${account}/history-imports`,
      startBody(agentIdentity),
      { "idempotency-key": `${key}-agent-denied` },
    );
    assert.equal(denied.status, 403);
    const crossAccount = await humanApi(
      "/api/v1/accounts/account_agent/history-imports",
      startBody(humanIdentity),
      { "idempotency-key": `${key}-cross-account` },
    );
    assert.equal(crossAccount.status, 404);
    return {
      managed_agent_start_status: denied.status,
      human_wrong_owner_account_status: crossAccount.status,
      agent_promoted: false,
    };
  });

  await observe("history-human-import-real-worker-gateway-sdk", async () => {
    assert.ok(initialEffects, "verified authority prerequisites required");
    const started = await humanApi(
      `/api/v1/accounts/${account}/history-imports`,
      startBody(humanIdentity),
      { "idempotency-key": key },
    );
    assert.ok(
      [200, 201].includes(started.status),
      "production history start must succeed",
    );
    detail = started.body;
    requireImport();
    assert.equal(detail.import.account_id, account);
    assert.equal(detail.import.identity_id, humanIdentity);
    assert.equal(detail.import.availability, "available");
    // The actual gateway normally returns one range. Keep a finite allowance
    // for the production range list rather than inventing a runner/tick adapter.
    for (
      let attempt = 0;
      detail.import.status !== "completed" && attempt < 5;
      attempt += 1
    ) {
      const range = detail.ranges.find((item) =>
        ["active", "pending", "partial"].includes(item.status),
      );
      assert.ok(range, "runnable actual history range required");
      const advanced = await humanApi(
        `/api/v1/history-imports/${encodeURIComponent(detail.import.import_id)}/advance`,
        {
          identity_id: humanIdentity,
          range_id: range.range_id,
        },
      );
      assert.equal(advanced.status, 200);
      detail = advanced.body;
      assert.equal(
        detail.import.last_error_code,
        null,
        "real gateway/import must not hide a provider failure",
      );
    }
    assert.equal(
      detail.import.status,
      "completed",
      "bounded actual history import must complete",
    );
    assert.ok(
      detail.import.event_count >= 2,
      "encrypted text and media must enter production projection",
    );
    assert.ok(detail.ranges.every((range) => range.status === "completed"));
    const persisted = await database
      .prepare(
        "SELECT status, event_count, identity_id, account_id FROM history_imports WHERE tenant_id = ? AND import_id = ?",
      )
      .bind(tenant, detail.import.import_id)
      .first();
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted.event_count, detail.import.event_count);
    assert.equal(persisted.identity_id, humanIdentity);
    assert.equal(persisted.account_id, account);
    const readDetail = await humanApi(
      `/api/v1/history-imports/${encodeURIComponent(detail.import.import_id)}?identity_id=${humanIdentity}`,
    );
    assert.equal(readDetail.status, 200);
    assert.equal(readDetail.body.import.status, "completed");
    assert.equal(readDetail.body.import.event_count, detail.import.event_count);
    const listed = await api(
      `/api/v1/accounts/${account}/history-imports?identity_id=${agentIdentity}&limit=100`,
    );
    assert.equal(listed.status, 200);
    assert.ok(
      listed.body.items.some(
        (item) => item.import_id === detail.import.import_id,
      ),
    );
    const repeated = await humanApi(
      `/api/v1/accounts/${account}/history-imports`,
      startBody(humanIdentity),
      { "idempotency-key": key },
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.import.import_id, detail.import.import_id);
    assert.equal(repeated.body.import.event_count, detail.import.event_count);
    return {
      authenticated_human_start_status: started.status,
      status: detail.import.status,
      projected_backfill_event_count: detail.import.event_count,
      completed_ranges: detail.ranges.length,
      d1_checkpoint_verified: true,
      human_detail_status: readDetail.status,
      granted_agent_history_list_status: listed.status,
      idempotent_start_same_import: true,
    };
  });

  await observe("encrypted-context-authenticated-stored-read", async () => {
    requireImport();
    assert.equal(detail.import.status, "completed");
    const messages = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({
        identity_id: agentIdentity,
        account_id: account,
        limit: "100",
      });
      if (cursor) query.set("cursor", cursor);
      const result = await api(`${messagePath}?${query}`);
      assert.equal(result.status, 200);
      assert.ok(Array.isArray(result.body.items));
      messages.push(...result.body.items);
      cursor = result.body.next_cursor;
      if (!cursor) break;
    }
    importedText = messages.find(
      (item) =>
        typeof item.body === "string" &&
        hash(item.body) === gatewayReady.controlled_expected_text_digest,
    );
    assert.ok(
      importedText,
      "actual stored read must expose decrypted controlled text matching readiness digest",
    );
    assert.equal(importedText.account_id, account);
    assert.equal(importedText.identity_id, humanIdentity);
    assert.equal(importedText.conversation_id, conversation);
    attachment = messages
      .flatMap((item) => item.attachments ?? [])
      .find((item) => item.sha256 === gatewayReady.file_digest);
    assert.ok(
      attachment,
      "actual projected encrypted attachment digest required",
    );
    assert.equal(attachment.availability, "available");
    assert.equal(attachment.size_bytes, gatewayReady.file_size_bytes);
    return {
      agent_read_status: 200,
      resource_owner_identity: humanIdentity,
      actor_identity: agentIdentity,
      decrypted_text_sha256: hash(importedText.body),
      encrypted_media_sha256: attachment.sha256,
      expected_fixture_digest_matched: true,
    };
  });

  await observe("attachment-access-real-authenticated-binary", async () => {
    assert.ok(attachment, "projected encrypted attachment prerequisite");
    const result = await api(
      metadataPath(attachment.attachment_id, agentIdentity, account),
    );
    assert.equal(result.status, 200);
    metadata = result.body;
    assert.equal(metadata.availability, "available");
    assert.equal(metadata.sha256, gatewayReady.file_digest);
    assert.equal(metadata.size_bytes, gatewayReady.file_size_bytes);
    assert.ok(
      typeof metadata.download_grant === "string" &&
        metadata.download_grant.length >= 32,
      "real Worker download grant required",
    );
    const response = await rawApi(
      `/api/v1/attachments/${encodeURIComponent(attachment.attachment_id)}/download`,
      undefined,
      { "x-communicator-download-grant": metadata.download_grant },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.byteLength, gatewayReady.file_size_bytes);
    assert.equal(
      hash(bytes),
      gatewayReady.file_digest,
      "actual decrypted download bytes must match independent fixture digest",
    );
    return {
      metadata_http_status: result.status,
      binary_http_status: response.status,
      bytes_verified: bytes.byteLength,
      sha256: hash(bytes),
      download_grant_source: "authenticated production metadata route",
      binary_source:
        "actual SDK-context-decrypted Matrix media through production Worker",
    };
  });

  await observe(
    "history-attachment-cross-account-and-grant-denial",
    async () => {
      assert.ok(
        attachment && metadata?.download_grant,
        "verified attachment prerequisites required",
      );
      const wrongMetadata = await api(
        metadataPath(attachment.attachment_id, agentIdentity, "account_agent"),
      );
      assert.ok(
        [403, 404].includes(wrongMetadata.status),
        "attachment from human account must not resolve through another account",
      );
      assert.equal(wrongMetadata.body.download_grant, undefined);
      const wrongRead = await api(
        `${messagePath}?identity_id=${agentIdentity}&account_id=account_agent&limit=100`,
      );
      assert.ok([200, 403, 404].includes(wrongRead.status));
      if (wrongRead.status === 200) {
        assert.ok(Array.isArray(wrongRead.body.items));
        assert.ok(
          wrongRead.body.items.every((item) => item.id !== importedText.id),
        );
        assert.ok(
          wrongRead.body.items.every(
            (item) =>
              hash(item.body) !== gatewayReady.controlled_expected_text_digest,
          ),
        );
      }
      const wrongAttachment = await rawApi(
        "/api/v1/attachments/attachment_integrated_not_the_granted_file/download",
        undefined,
        { "x-communicator-download-grant": metadata.download_grant },
      );
      assert.equal(
        wrongAttachment.status,
        403,
        "valid grant must remain bound to its exact attachment",
      );
      const denied = await wrongAttachment.json();
      assert.equal(denied.error.code, "forbidden");
      return {
        wrong_account_metadata_status: wrongMetadata.status,
        cross_account_stored_read_status: wrongRead.status,
        cross_account_content_visible: false,
        mismatched_attachment_grant_status: wrongAttachment.status,
        downloaded_bytes_released_on_denial: false,
      };
    },
  );

  await observe(
    "history-read-import-media-no-receipt-side-effects",
    async () => {
      assert.ok(initialEffects, "actual effects baseline required");
      const final = await effects();
      assert.equal(final.matrix_receipts, initialEffects.matrix_receipts);
      assert.equal(final.receipt_operations, initialEffects.receipt_operations);
      assert.equal(final.matrix_sends, initialEffects.matrix_sends);
      const role = await database
        .prepare(
          "SELECT role FROM memberships WHERE id = 'membership_agent' AND tenant_id = ?",
        )
        .bind(tenant)
        .first();
      assert.equal(role?.role, "member");
      return {
        additional_matrix_receipts: 0,
        additional_receipt_operations: 0,
        additional_matrix_sends: 0,
        agent_membership_role: role.role,
        fixture_grant_mutations: 0,
      };
    },
  );
}
