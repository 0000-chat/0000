import assert from "node:assert/strict";

const tenant = "tenant_pilot";
const identity = "identity_human";
const account = "account_human";
const connection = "connection_human_whatsapp";
const conversation = "conversation_integrated";
const message = "message_integrated";
const groupName = "T13 controlled group";
const groupId = "provider_group_integrated_operations";
const room = "!integrated:example.test";

// All mutations use the real human OAuth credential and production private
// authority claims. Fixture D1 writes describe only the bounded local provider
// capability and pre-existing group snapshot; they never authorize a dispatch.
// No fixtureCall/wrapper hook is required by this module.
export async function runOperationsProof({
  observe,
  api,
  humanApi,
  getRuntime,
  calls,
}) {
  const db = await getRuntime().getD1Database("CONTROL_DB", "communicator");
  const receiptPath = `/api/v1/conversations/${conversation}/receipts/read`;
  const receiptRequest = {
    schema_version: 1,
    identity_id: identity,
    account_id: account,
    message_id: message,
    idempotency_key: "integrated-operations-receipt",
  };
  const renameRequest = {
    identity_id: identity,
    account_id: account,
    conversation_id: conversation,
    expected_revision: "0",
    idempotency_key: "integrated-operations-group-rename",
    name: groupName,
  };
  let receipt;
  let renamed;
  let groupReady = false;
  let insertedScope = false;
  let insertedCapability = false;
  const receiptCount = async () => {
    const counters = await calls();
    assert.ok(
      Number.isSafeInteger(counters.receipt_requests),
      "sidecar receipt counter is required",
    );
    return counters.receipt_requests;
  };
  const groupClaims = () =>
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM group_dispatch_claims WHERE tenant_id = ? AND conversation_id = ? AND operation_kind = 'group.manage'",
      )
      .bind(tenant, conversation)
      .first();

  try {
    await observe("operations-read-only-no-receipt", async () => {
      const before = await receiptCount();
      const read = await humanApi(
        `/api/v1/conversations/${conversation}/messages?identity_id=${identity}&account_id=${account}`,
      );
      assert.equal(read.status, 200);
      assert.ok(JSON.stringify(read.body).includes(message));
      assert.equal(await receiptCount(), before);
      return { http_status: 200, additional_matrix_receipts: 0 };
    });

    await observe("operations-explicit-receipt-success", async () => {
      const before = await receiptCount();
      const tupleStart = (await calls()).receipt_tuples.length;
      receipt = await humanApi(receiptPath, receiptRequest);
      assert.equal(receipt.status, 200);
      assert.equal(receipt.body.status, "accepted");
      assert.equal(receipt.body.replayed, false);
      assert.equal(receipt.body.matrix_stage, "accepted");
      assert.equal(receipt.body.bridge_stage, "unknown");
      assert.equal(receipt.body.provider_stage, "unknown");
      assert.equal(receipt.body.failure_code, null);
      assert.ok(
        receipt.body.evidence.some(
          (item) => item.source === "matrix" && item.status === "accepted",
        ),
      );
      assert.equal(await receiptCount(), before + 1);
      const tuples = (await calls()).receipt_tuples.slice(tupleStart);
      assert.deepEqual(tuples, [
        { room_id: room, kind: "m.read", event_id: "$inbound:example.test" },
      ]);
      return {
        http_status: 200,
        operation_status: "accepted",
        additional_matrix_receipts: 1,
        matrix_stage: "accepted",
        provider_stage: "unknown",
        provider_read_confirmation_claimed: false,
        actual_matrix_receipt_tuple: tuples[0],
      };
    });

    await observe("operations-explicit-receipt-replay", async () => {
      assert.equal(
        receipt?.body.status,
        "accepted",
        "successful original receipt is required",
      );
      const before = await receiptCount();
      const replay = await humanApi(receiptPath, receiptRequest);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.operation_id, receipt.body.operation_id);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.matrix_stage, "accepted");
      assert.equal(await receiptCount(), before);
      return {
        http_status: 200,
        same_persisted_operation: true,
        replayed: true,
        additional_matrix_receipts: 0,
      };
    });

    await observe("operations-receipt-identity-scope-denied", async () => {
      const existing = await db
        .prepare(
          "SELECT created_at FROM identity_grants WHERE tenant_id = ? AND membership_id = 'membership_human' AND identity_id = ? AND operation_scope = 'receipt.send'",
        )
        .bind(tenant, identity)
        .first();
      assert.ok(existing, "baseline human receipt scope is required");
      const before = await receiptCount();
      try {
        await db
          .prepare(
            "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = 'membership_human' AND identity_id = ? AND operation_scope = 'receipt.send'",
          )
          .bind(tenant, identity)
          .run();
        const denied = await humanApi(receiptPath, {
          ...receiptRequest,
          idempotency_key: "integrated-operations-receipt-no-scope",
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error.code, "forbidden");
        assert.equal(await receiptCount(), before);
      } finally {
        await db
          .prepare(
            "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, 'membership_human', ?, 'receipt.send', ?)",
          )
          .bind(tenant, identity, existing.created_at)
          .run();
      }
      return {
        http_status: 403,
        removed_scope: "receipt.send",
        identity_scope_restored: true,
        owner_role_did_not_bypass_identity_scope: true,
        additional_matrix_receipts: 0,
      };
    });

    await observe(
      "operations-receipt-managed-actor-owner-scope-denied",
      async () => {
        const before = await receiptCount();
        const denied = await api(receiptPath, {
          ...receiptRequest,
          idempotency_key: "integrated-operations-receipt-wrong-actor",
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error.code, "forbidden");
        assert.equal(await receiptCount(), before);
        return {
          http_status: 403,
          managed_actor_cannot_select_human_identity: true,
          additional_matrix_receipts: 0,
        };
      },
    );

    await observe("operations-controlled-group-fixture", async () => {
      const now = new Date().toISOString();
      const existingGroup = await db
        .prepare(
          "SELECT conversation_id FROM group_management_groups WHERE tenant_id = ? AND conversation_id = ?",
        )
        .bind(tenant, conversation)
        .first();
      assert.equal(
        existingGroup,
        null,
        "refuse to overwrite another group's state",
      );
      const scope = await db
        .prepare(
          "SELECT 1 AS present FROM identity_grants WHERE tenant_id = ? AND membership_id = 'membership_human' AND identity_id = ? AND operation_scope = 'group.manage'",
        )
        .bind(tenant, identity)
        .first();
      if (scope === null) {
        await db
          .prepare(
            "INSERT INTO identity_grants (tenant_id, membership_id, identity_id, operation_scope, created_at) VALUES (?, 'membership_human', ?, 'group.manage', ?)",
          )
          .bind(tenant, identity, now)
          .run();
        insertedScope = true;
      }
      const capability = await db
        .prepare(
          "SELECT status, freshness FROM provider_capability_records WHERE tenant_id = ? AND account_id = ? AND capability = 'group.manage'",
        )
        .bind(tenant, account)
        .first();
      if (capability === null) {
        await db
          .prepare(`INSERT INTO provider_capability_records (tenant_id, account_id, connection_id, identity_id, provider, capability, status, freshness, proof_source, provider_evidence_json, product_claim, observed_at, updated_at)
          VALUES (?, ?, ?, ?, 'whatsapp', 'group.manage', 'conditional', 'unknown', 'integrated-operations-controlled-matrix-fixture', ?, 'Only the local T13 exact-name rename fixture; not a live WhatsApp capability claim', ?, ?)`)
          .bind(
            tenant,
            account,
            connection,
            identity,
            JSON.stringify({
              controlled: true,
              boundary: "Matrix SDK exact-name rename",
              name: groupName,
            }),
            now,
            now,
          )
          .run();
        insertedCapability = true;
      } else {
        assert.ok(
          ["supported", "conditional"].includes(capability.status),
          "existing capability must allow group management; do not overwrite it",
        );
        assert.ok(
          ["fresh", "unknown", "stale"].includes(capability.freshness),
          "existing capability freshness must allow group management",
        );
      }
      // The sidecar's existing outbound binding is for conversation_integrated.
      // Its synthetic room has no bridge-ghost members, hence the empty member
      // snapshot. This is initial fixture state, not successful result evidence.
      await db
        .prepare(`INSERT INTO group_management_groups (tenant_id, identity_id, account_id, connection_id, provider, conversation_id, provider_group_id, matrix_room_id, name, current_revision, current_member_provider_ids_json, current_evidence_json, active_operation_id, active_claim_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, ?, 'Controlled pre-rename snapshot', '0', '[]', NULL, NULL, NULL, ?, ?)`)
        .bind(
          tenant,
          identity,
          account,
          connection,
          conversation,
          groupId,
          room,
          now,
          now,
        )
        .run();
      groupReady = true;
      return {
        initial_revision: "0",
        successful_result_evidence_seeded: false,
        fixture_scope: "local controlled Matrix exact-name rename",
        dispatch_authority:
          "real human owner and production private authority claim",
      };
    });

    await observe("operations-group-rename-real-gateway", async () => {
      assert.equal(groupReady, true);
      const before = await calls();
      renamed = await humanApi(
        `/api/v1/groups/${conversation}`,
        renameRequest,
        {},
        "PATCH",
      );
      assert.equal(renamed.status, 200);
      assert.equal(
        renamed.body.status,
        "succeeded",
        `group rename failure code: ${renamed.body.failure_code}`,
      );
      assert.equal(renamed.body.current_name, groupName);
      assert.notEqual(renamed.body.current_revision, "0");
      assert.equal(renamed.body.result_revision, renamed.body.current_revision);
      assert.equal(
        renamed.body.evidence?.evidence_id,
        "$t13-group-success:example.test",
      );
      assert.equal(renamed.body.evidence.status, "confirmed");
      assert.equal(
        renamed.body.evidence.operation_id,
        renamed.body.operation_id,
      );
      assert.equal(renamed.body.evidence.accepted, true);
      assert.equal(renamed.body.duplicate_risk, false);
      assert.equal((await calls()).rename_requests, before.rename_requests + 1);
      const claims = await groupClaims();
      assert.ok(
        claims.count > 0,
        "production gateway must claim private authority",
      );
      return {
        http_status: 200,
        operation_status: "succeeded",
        revision_advanced: true,
        controlled_bot_status_observed_after_actual_matrix_name_mutation: true,
        gateway_authority_claim_persisted: true,
        live_provider_confirmation_claimed: false,
      };
    });

    await observe("operations-group-rename-replay", async () => {
      assert.equal(renamed?.body.status, "succeeded");
      const before = await groupClaims();
      const ioBefore = await calls();
      const evidenceBefore = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM group_management_evidence WHERE tenant_id = ? AND operation_id = ?",
        )
        .bind(tenant, renamed.body.operation_id)
        .first();
      const replay = await humanApi(
        `/api/v1/groups/${conversation}`,
        renameRequest,
        {},
        "PATCH",
      );
      assert.equal(replay.status, 200);
      assert.equal(replay.body.status, "succeeded");
      assert.equal(replay.body.operation_id, renamed.body.operation_id);
      assert.equal(replay.body.result_revision, renamed.body.result_revision);
      assert.equal((await groupClaims()).count, before.count);
      const evidenceAfter = await db
        .prepare(
          "SELECT COUNT(*) AS count FROM group_management_evidence WHERE tenant_id = ? AND operation_id = ?",
        )
        .bind(tenant, renamed.body.operation_id)
        .first();
      assert.equal(evidenceAfter.count, evidenceBefore.count);
      assert.equal((await calls()).rename_requests, ioBefore.rename_requests);
      return {
        http_status: 200,
        same_persisted_operation: true,
        additional_gateway_authority_claims: 0,
        additional_result_evidence: 0,
        additional_matrix_renames: 0,
      };
    });

    await observe("operations-group-stale-revision-denied", async () => {
      assert.equal(renamed?.body.status, "succeeded");
      const before = await groupClaims();
      const ioBefore = await calls();
      const stale = await humanApi(
        `/api/v1/groups/${conversation}`,
        {
          ...renameRequest,
          idempotency_key: "integrated-operations-group-stale",
          name: "Controlled stale revision must not rename",
        },
        {},
        "PATCH",
      );
      assert.equal(stale.status, 200);
      assert.equal(stale.body.status, "human_action_required");
      assert.equal(stale.body.failure_code, "group_revision_conflict");
      assert.equal(stale.body.current_name, groupName);
      assert.equal(stale.body.current_revision, renamed.body.current_revision);
      assert.equal(stale.body.evidence, null);
      assert.equal((await groupClaims()).count, before.count);
      const reservation = await db
        .prepare(
          "SELECT id FROM group_authority_intents WHERE tenant_id = ? AND operation_id = ?",
        )
        .bind(tenant, stale.body.operation_id)
        .first();
      assert.equal(
        reservation,
        null,
        "stale group revision must fail before authority reservation/provider I/O",
      );
      assert.equal((await calls()).rename_requests, ioBefore.rename_requests);
      return {
        http_status: 200,
        operation_status: "human_action_required",
        failure_code: "group_revision_conflict",
        persisted_name_and_revision_unchanged: true,
        provider_reservation_created: false,
        additional_gateway_authority_claims: 0,
      };
    });
  } finally {
    if (insertedScope)
      await db
        .prepare(
          "DELETE FROM identity_grants WHERE tenant_id = ? AND membership_id = 'membership_human' AND identity_id = ? AND operation_scope = 'group.manage'",
        )
        .bind(tenant, identity)
        .run();
    if (insertedCapability)
      await db
        .prepare(
          "DELETE FROM provider_capability_records WHERE tenant_id = ? AND account_id = ? AND capability = 'group.manage' AND proof_source = 'integrated-operations-controlled-matrix-fixture'",
        )
        .bind(tenant, account)
        .run();
  }
}
