import assert from "node:assert/strict";

const tenant = "tenant_pilot";
const connection = "connection_human_whatsapp";
const fourHours = 14_400_000;
const path = (id, operation = "") =>
  `/api/v1/commands/${id}${operation ? `/${operation}` : ""}`;

// Required wrapper: handleRecoveryFixture for /__fixture/recovery/*.
// send(key, patch) is the normal real agent HTTP send, except the exact key
// integrated-recovery-uncertain must lose a response AFTER a real sidecar send.
// Alternatively supply uncertainAccepted: a lazy async callback returning the
// original 202 {status, body} after that genuinely uncertain send. An already
// paused command must not be created before the offline proof on the same chat.
// Invoke before removal/restore, with valid human+agent credentials. The
// lifecycle clock is stepped, not Platform's independent authority clock.
export async function runRecoveryProof({
  observe,
  api,
  humanApi,
  getRuntime,
  calls,
  fixtureCall,
  send,
  uncertainAccepted,
}) {
  const db = await getRuntime().getD1Database("CONTROL_DB", "communicator");
  const counter = async () => {
    const value = (await calls()).send_requests;
    assert.ok(
      Number.isSafeInteger(value),
      "actual sidecar send_requests counter required",
    );
    return value;
  };
  const step = async (id, now) => {
    const result = await fixtureCall("/__fixture/recovery/step", {
      command_id: id,
      now,
    });
    assert.equal(
      result.status,
      200,
      "real recovery fixture required; missing fixture is NOT acceptance",
    );
    assert.equal(result.body.clock, now);
    return result.body;
  };
  let offline;
  let baseline;
  let due;
  let savedHash;
  let originalExpiry;
  const boundaryCommands = new Set();
  const initial = await db
    .prepare("SELECT status FROM connections WHERE tenant_id = ? AND id = ?")
    .bind(tenant, connection)
    .first();
  assert.ok(
    initial && ["connected", "syncing", "ready"].includes(initial.status),
  );
  try {
    await observe("recovery-offline-real-http-acceptance", async () => {
      baseline = await counter();
      await db
        .prepare(
          "UPDATE connections SET status = 'disconnected' WHERE tenant_id = ? AND id = ?",
        )
        .bind(tenant, connection)
        .run();
      offline = await send("integrated-recovery-offline");
      assert.equal(offline.status, 202);
      assert.equal(offline.body.status, "waiting_for_connection");
      const status = await humanApi(path(offline.body.id, "reconcile"), {});
      assert.equal(status.status, 200);
      assert.equal(status.body.dispatch.status, "waiting_for_connection");
      const created = status.body.dispatch.created_at;
      due = new Date(Date.parse(created) + fourHours).toISOString();
      assert.equal(status.body.dispatch.confirmation_due_at, due);
      const persisted = await step(offline.body.id, created);
      assert.equal(persisted.dispatch.status, "waiting_for_connection");
      savedHash = persisted.dispatch.saved_authority_sha256;
      assert.match(savedHash, /^[a-f0-9]{64}$/);
      assert.equal(persisted.authority_validation, "allowed");
      originalExpiry = persisted.authority_expires_at;
      assert.ok(Number.isSafeInteger(Date.parse(originalExpiry)));
      assert.ok(
        Date.parse(originalExpiry) < Date.parse(due),
        "bounded original credential must not be renewed for the four-hour proof",
      );
      assert.equal(persisted.dispatch.account_id, "account_human");
      assert.equal(persisted.dispatch.connection_id, connection);
      assert.equal(await counter(), baseline);
      return {
        http_status: 202,
        real_sqlite_do_saved: true,
        confirmation_due_at: due,
        originating_authority_expires_at: originalExpiry,
        authority_expires_before_confirmation_deadline: true,
        additional_matrix_sends: 0,
        acceptance_is_not_delivery: true,
      };
    });

    for (const [label, offset, expected] of [
      ["minus-one", -1, "waiting_for_connection"],
      ["exact", 0, "confirmation_required"],
      ["plus-one", 1, "confirmation_required"],
    ]) {
      await observe(`recovery-four-hours-${label}`, async () => {
        if (label !== "minus-one") {
          offline = await send(`integrated-recovery-offline-${label}`);
          assert.equal(offline.status, 202);
          assert.equal(offline.body.status, "waiting_for_connection");
          const status = await humanApi(path(offline.body.id, "reconcile"), {});
          assert.equal(status.status, 200);
          assert.equal(status.body.dispatch.status, "waiting_for_connection");
          const created = status.body.dispatch.created_at;
          due = new Date(Date.parse(created) + fourHours).toISOString();
          assert.equal(status.body.dispatch.confirmation_due_at, due);
          const persisted = await step(offline.body.id, created);
          assert.equal(persisted.dispatch.status, "waiting_for_connection");
          savedHash = persisted.dispatch.saved_authority_sha256;
          assert.match(savedHash, /^[a-f0-9]{64}$/);
          assert.equal(persisted.authority_validation, "allowed");
          originalExpiry = persisted.authority_expires_at;
          assert.ok(Number.isSafeInteger(Date.parse(originalExpiry)));
          assert.ok(Date.parse(originalExpiry) < Date.parse(due));
          assert.equal(persisted.dispatch.account_id, "account_human");
          assert.equal(persisted.dispatch.connection_id, connection);
        }
        assert.ok(
          offline?.body.id && due && savedHash,
          "offline acceptance prerequisite failed",
        );
        assert.ok(!boundaryCommands.has(offline.body.id));
        boundaryCommands.add(offline.body.id);
        const now = new Date(Date.parse(due) + offset).toISOString();
        const result = await step(offline.body.id, now);
        assert.equal(result.dispatch.status, expected);
        assert.equal(result.dispatch.confirmation_due_at, due);
        assert.equal(result.dispatch.saved_authority_sha256, savedHash);
        assert.equal(result.authority_expires_at, originalExpiry);
        assert.equal(result.dispatch.account_id, "account_human");
        assert.equal(result.dispatch.connection_id, connection);
        assert.equal(await counter(), baseline);
        if (label !== "plus-one") {
          const cancelled = await humanApi(path(offline.body.id, "cancel"), {
            idempotency_key: `integrated-recovery-boundary-cleanup-${label}`,
          });
          assert.equal(cancelled.status, 200);
          const cleaned = await humanApi(path(offline.body.id));
          assert.equal(cleaned.status, 200);
          assert.equal(cleaned.body.dispatch.status, "cancelled");
          assert.equal(cleaned.body.dispatch.chat_paused, false);
          assert.equal(await counter(), baseline);
        }
        return {
          stepped_now: now,
          dispatch_status: expected,
          independently_waiting_command: true,
          command_id: offline.body.id,
          immutable_deadline: true,
          original_authority_preserved: true,
          additional_matrix_sends: 0,
          silent_failover: false,
        };
      });
    }

    await observe(
      "recovery-human-confirm-stale-original-fails-closed",
      async () => {
        assert.ok(offline?.body.id && due && savedHash);
        await db
          .prepare(
            "UPDATE connections SET status = ? WHERE tenant_id = ? AND id = ?",
          )
          .bind(initial.status, tenant, connection)
          .run();
        const now = new Date(Date.parse(due) + 1).toISOString();
        const before = await step(offline.body.id, now);
        assert.equal(
          before.dispatch.status,
          "confirmation_required",
          "reconnection must not silently confirm",
        );
        const denied = await api(path(offline.body.id, "confirm"), {
          idempotency_key: "integrated-recovery-agent-confirm",
        });
        assert.equal(denied.status, 403);
        const confirmed = await humanApi(path(offline.body.id, "confirm"), {
          idempotency_key: "integrated-recovery-human-confirm",
        });
        assert.equal(confirmed.status, 200);
        const after = await step(offline.body.id, now);
        assert.equal(after.dispatch.saved_authority_sha256, savedHash);
        assert.equal(after.dispatch.confirmation_decision, "confirm");
        assert.equal(
          after.dispatch.confirmation_actor_principal_id,
          "principal_human",
        );
        assert.equal(after.dispatch.status, "cancelled");
        assert.equal(
          after.dispatch.uncertainty_reason,
          "authorization_revoked",
        );
        assert.equal(await counter(), baseline);
        return {
          real_human_http_decision: true,
          agent_confirmation_denied: true,
          original_saved_authority_unchanged: true,
          original_credential_not_renewed: true,
          terminal_dispatch_status: after.dispatch.status,
          additional_matrix_sends: 0,
          four_hour_original_execution_claimed: false,
          authority_expiry_independently_clock_stepped: false,
          fail_closed_boundary:
            "connection status transitions revoke the original account-grant epoch",
        };
      },
    );
  } finally {
    await db
      .prepare(
        "UPDATE connections SET status = ? WHERE tenant_id = ? AND id = ?",
      )
      .bind(initial.status, tenant, connection)
      .run();
    if (offline?.status === 202) {
      const current = await humanApi(path(offline.body.id));
      assert.equal(current.status, 200);
      if (
        ["pending", "waiting_for_connection", "confirmation_required"].includes(
          current.body.dispatch.status,
        ) &&
        current.body.dispatch.confirmation_decision === undefined
      ) {
        const cancelled = await humanApi(path(offline.body.id, "cancel"), {
          idempotency_key: "integrated-recovery-cleanup",
        });
        assert.equal(cancelled.status, 200);
      }
    }
  }

  let original;
  let resend;
  let originalCount;
  let originalTransaction;
  let originalTuples;
  const sendTuples = async () => {
    const stats = await calls();
    assert.ok(
      Array.isArray(stats.send_tuples),
      "actual Matrix send tuples required",
    );
    assert.equal(stats.send_tuples.length, stats.send_requests);
    return stats.send_tuples;
  };
  const matrixTuple = (transaction) => {
    assert.equal(typeof transaction, "string");
    assert.ok(transaction.length > 0);
    return {
      room_id: "!integrated:example.test",
      event_type: "m.room.encrypted",
      transaction_id: transaction,
    };
  };
  await observe("recovery-genuine-lost-send-response-not-retried", async () => {
    const before = await counter();
    original =
      typeof uncertainAccepted === "function"
        ? await uncertainAccepted()
        : (uncertainAccepted ?? (await send("integrated-recovery-uncertain")));
    assert.equal(original.status, 202);
    const status = await humanApi(path(original.body.id, "reconcile"), {});
    assert.equal(status.status, 200);
    assert.equal(
      status.body.dispatch.status,
      "delivery_uncertain",
      "a real accepted POST must lose its result; never seed uncertain state",
    );
    assert.equal(status.body.dispatch.chat_paused, true);
    originalCount = await counter();
    if (
      uncertainAccepted === undefined ||
      typeof uncertainAccepted === "function"
    )
      assert.equal(
        originalCount,
        before + 1,
        "response loss must happen AFTER actual Matrix send",
      );
    else
      assert.ok(
        originalCount > 0,
        "supplied original requires actual sidecar send evidence",
      );
    const persisted = await step(original.body.id, new Date().toISOString());
    originalTransaction = persisted.dispatch.transaction_id;
    originalTuples = await sendTuples();
    assert.deepEqual(originalTuples.at(-1), matrixTuple(originalTransaction));
    for (let pass = 0; pass < 3; pass++) {
      const result = await step(original.body.id, new Date().toISOString());
      assert.equal(result.dispatch.status, "delivery_uncertain");
      assert.equal(await counter(), originalCount);
      assert.deepEqual(await sendTuples(), originalTuples);
    }
    return {
      genuine_uncertain_send_observed: true,
      chat_paused: true,
      repeated_recovery_passes: 3,
      additional_matrix_sends_during_recovery: 0,
    };
  });

  await observe("recovery-explicit-audited-human-resend", async () => {
    assert.ok(original?.body.id && Number.isSafeInteger(originalCount));
    const body = {
      idempotency_key: "integrated-recovery-explicit-resend",
      duplicate_risk_acknowledged: true,
    };
    resend = await humanApi(path(original.body.id, "resend"), body);
    assert.equal(resend.status, 200);
    assert.notEqual(resend.body.command.id, original.body.id);
    assert.equal(resend.body.dispatch.resend_of_command_id, original.body.id);
    assert.equal(resend.body.dispatch.duplicate_risk, true);
    assert.notEqual(resend.body.dispatch.status, "delivery_uncertain");
    assert.ok(
      ["dispatched", "delivered"].includes(resend.body.dispatch.status),
      "real gateway dispatch required",
    );
    assert.equal(await counter(), originalCount + 1);
    const replacement = await step(
      resend.body.command.id,
      new Date().toISOString(),
    );
    const replacementTransaction = replacement.dispatch.transaction_id;
    assert.notEqual(replacementTransaction, originalTransaction);
    const replacementTuples = await sendTuples();
    assert.deepEqual(replacementTuples.slice(0, originalCount), originalTuples);
    assert.deepEqual(replacementTuples.slice(originalCount), [
      matrixTuple(replacementTransaction),
    ]);
    const source = await humanApi(path(original.body.id));
    assert.equal(source.status, 200);
    assert.equal(source.body.dispatch.last_action, "resend");
    assert.equal(
      source.body.dispatch.last_action_actor_principal_id,
      "principal_human",
    );
    assert.equal(source.body.dispatch.status, "delivery_uncertain");
    const replay = await humanApi(path(original.body.id, "resend"), body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.command.id, resend.body.command.id);
    for (const id of [original.body.id, resend.body.command.id])
      await step(id, new Date().toISOString());
    assert.equal(await counter(), originalCount + 1);
    assert.deepEqual(await sendTuples(), replacementTuples);
    return {
      real_human_resend_audited: true,
      duplicate_risk_acknowledged: true,
      new_command_distinct_from_original: true,
      new_stored_transaction_distinct_from_original: true,
      actual_matrix_tuple_matches_replacement: true,
      resend_replay_and_recovery_emit_no_third_send: true,
      additional_matrix_sends: 1,
      original_automatically_retried: false,
      idempotent_resend_replay: true,
      provider_delivery_not_inferred: true,
    };
  });
}
