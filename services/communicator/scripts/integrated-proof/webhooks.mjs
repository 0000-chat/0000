import assert from "node:assert/strict";

const receiverOrigin = "https://webhook.integrated.test";
const calls = [];
const receiverPaths = new Map([
  ["/failing", 503],
  ["/healthy", 204],
  ["/replacement", 204],
  ["/boundary", 503],
]);

// Main's outboundService must call this before its Platform-only routing.
// The transport is an actual Worker fetch captured by Miniflare's outbound
// service; no internet or provider is contacted. Never retain message bodies.
export async function webhookReceiver(request) {
  const url = new URL(request.url);
  if (url.origin !== receiverOrigin) return null;
  assert.equal(request.method, "POST");
  assert.ok(
    receiverPaths.has(url.pathname),
    "unexpected local webhook receiver",
  );
  const payload = await request.json();
  assert.equal(request.headers.get("idempotency-key"), payload.delivery_id);
  calls.push({
    path: url.pathname,
    delivery_id: payload.delivery_id,
    source_event_id: payload.source_event_id,
  });
  return new Response(null, { status: receiverPaths.get(url.pathname) });
}

export async function runWebhookProof({
  observe,
  api,
  getRuntime,
  fixtureCall,
}) {
  calls.length = 0;
  const database = await getRuntime().getD1Database(
    "CONTROL_DB",
    "communicator",
  );
  const original = await database
    .prepare("SELECT role FROM memberships WHERE id = 'membership_agent'")
    .first();
  assert.ok(original, "seeded membership missing");
  const created = [];
  const day = 24 * 60 * 60 * 1000;
  const start = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const fixture = async (path, body) => {
    if (fixtureCall) return fixtureCall(`/__fixture/webhook-${path}`, body);
    const response = await (await getRuntime().getWorker("communicator")).fetch(
      `http://fixture.test/__fixture/webhook-${path}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    assert.equal(response.status, 200, "webhook fixture entry unavailable");
    return response.json();
  };
  const tick = (ms) => fixture("tick", { now: iso(ms) });
  const emit = (key, ms) =>
    fixture("emit", { key: `webhook_proof_${key}`, now: iso(ms) });
  const row = (subscription, event) =>
    database
      .prepare(`SELECT id, subscription_id, source_event_id, destination_version, status, first_pending_at, retry_deadline, attempt_count, next_attempt_at, cancellation_reason, error_code
    FROM webhook_deliveries WHERE subscription_id = ? AND source_event_id = ?`)
      .bind(subscription.id, `event_webhook_proof_${event}`)
      .first();
  const count = (id, path) =>
    calls.filter(
      (call) => call.delivery_id === id && (!path || call.path === path),
    ).length;
  const create = async (name) => {
    const result = await api("/api/v1/webhook-subscriptions", {
      destination: { url: `${receiverOrigin}/${name}` },
      global_enabled: true,
      account_rules: [{ account_id: "account_human", enabled: true }],
      chat_rules: [],
      event_filter: { event_types: ["message.created"] },
      idempotency_key: `integrated-webhook-${name}`,
    });
    assert.equal(result.status, 201, "subscription creation");
    assert.ok(result.body.id);
    created.push(result.body);
    return result.body;
  };
  let failing;
  let healthy;
  let grantCreated = false;
  try {
    // Managed agents are not administrators even when their membership role is
    // admin. Exercise the real scoped management authority, not a type bypass.
    await database
      .prepare(`INSERT INTO account_grants (id, tenant_id, membership_id, identity_id, account_id, operation_scope, chat_scope, status, created_at, updated_at)
      VALUES ('grant_integrated_webhook_proof', 'tenant_pilot', 'membership_agent', 'identity_agent', 'account_human', 'webhook.manage', 'all_chats', 'active', ?, ?)`)
      .bind(iso(start), iso(start))
      .run();
    grantCreated = true;
    await observe("independent-webhook-cutover", async () => {
      failing = await create("failing");
      healthy = await create("healthy");
      assert.notEqual(failing.id, healthy.id);
      const emitted = await emit("independent", start);
      assert.equal(emitted.delivery_ids.length, 2);
      await tick(start);
      const failed = await row(failing, "independent");
      const delivered = await row(healthy, "independent");
      assert.equal(failed.status, "pending");
      assert.equal(failed.error_code, "http_503");
      assert.equal(delivered.status, "delivered");
      assert.equal(count(failed.id, "/failing"), 1);
      assert.equal(count(delivered.id, "/healthy"), 1);
      assert.equal(
        Date.parse(failed.retry_deadline) - Date.parse(failed.first_pending_at),
        day,
      );

      const retry = await api(`/api/v1/webhook-deliveries/${failed.id}/retry`, {
        idempotency_key: "integrated-webhook-retry",
      });
      assert.equal(
        retry.status,
        409,
        "pending automatic work is not terminal manual-retry work",
      );
      await tick(start + 120_000);
      const retried = await row(failing, "independent");
      assert.equal(retried.id, failed.id);
      assert.equal(retried.attempt_count, 2);
      assert.equal(retried.first_pending_at, failed.first_pending_at);
      assert.equal(retried.retry_deadline, failed.retry_deadline);
      assert.equal(count(failed.id, "/failing"), 2);
      assert.equal(count(delivered.id), 1);

      const cutover = await api(
        `/api/v1/webhook-subscriptions/${failing.id}/cutover`,
        {
          destination: { url: `${receiverOrigin}/replacement` },
          idempotency_key: "integrated-webhook-cutover",
        },
      );
      assert.equal(cutover.status, 200);
      assert.equal(
        cutover.body.destination_version,
        failing.destination_version + 1,
      );
      const cancelled = await row(failing, "independent");
      assert.equal(cancelled.status, "cancelled");
      assert.equal((await row(healthy, "independent")).status, "delivered");
      await tick(start + 240_000);
      assert.equal(
        count(failed.id),
        2,
        "cancelled old delivery must never reach replacement",
      );
      await emit("after_cutover", start + 240_000);
      await tick(start + 240_000);
      const replacement = await row(failing, "after_cutover");
      const independent = await row(healthy, "after_cutover");
      assert.equal(replacement.status, "delivered");
      assert.equal(
        replacement.destination_version,
        cutover.body.destination_version,
      );
      assert.equal(count(replacement.id, "/replacement"), 1);
      assert.equal(count(replacement.id, "/failing"), 0);
      assert.equal(independent.status, "delivered");
      assert.equal(count(independent.id, "/healthy"), 1);
      return {
        subscriptions_created_via_api: 2,
        projection_apply_batch: true,
        actual_worker_d1_sqlite_do: true,
        failing_receiver_attempts: 2,
        healthy_receiver_attempts_for_same_event: 1,
        automatic_retry_preserved_id_and_age: true,
        manual_retry_of_pending_work_http_status: 409,
        old_pending_cancelled_on_cutover: true,
        old_delivery_sent_to_replacement: false,
        new_event_delivered_to_replacement_and_healthy: true,
        transport:
          "controlled HTTP responses through Miniflare outboundService",
        time: "fixture services.now advancement; not wall-clock waiting",
      };
    });

    await observe("webhook-exact-24h-retry-boundary", async () => {
      const subscription = await create("boundary");
      const t0 = start + 300_000;
      await emit("boundary", t0);
      await tick(t0);
      const first = await row(subscription, "boundary");
      assert.equal(first.status, "pending");
      assert.equal(first.attempt_count, 1);
      assert.equal(Date.parse(first.first_pending_at), t0);
      assert.equal(Date.parse(first.retry_deadline), t0 + day);
      assert.equal(count(first.id), 1);
      await tick(t0 + day - 1);
      const before = await row(subscription, "boundary");
      assert.equal(before.status, "pending");
      assert.equal(before.attempt_count, 2);
      assert.equal(count(first.id), 2);
      assert.equal(before.next_attempt_at, first.retry_deadline);
      assert.equal(before.first_pending_at, first.first_pending_at);
      assert.equal(before.retry_deadline, first.retry_deadline);
      await tick(t0 + day);
      const exact = await row(subscription, "boundary");
      assert.equal(exact.status, "failed");
      assert.equal(exact.error_code, "retry_deadline_exceeded");
      assert.equal(exact.attempt_count, 2);
      assert.equal(exact.next_attempt_at, null);
      assert.equal(count(first.id), 2);
      await tick(t0 + day + 1);
      const after = await row(subscription, "boundary");
      assert.equal(after.status, "failed");
      assert.equal(after.attempt_count, 2);
      assert.equal(count(first.id), 2);
      const manual = await api(`/api/v1/webhook-deliveries/${first.id}/retry`, {
        idempotency_key: "integrated-webhook-post-deadline-manual",
      });
      assert.equal(
        manual.status,
        200,
        "explicit retry remains permitted after automatic deadline",
      );
      await tick(t0 + day + 2);
      const manuallyRetried = await row(subscription, "boundary");
      assert.equal(manuallyRetried.id, first.id);
      assert.equal(manuallyRetried.first_pending_at, first.first_pending_at);
      assert.equal(manuallyRetried.retry_deadline, first.retry_deadline);
      assert.equal(manuallyRetried.attempt_count, 3);
      assert.equal(manuallyRetried.status, "failed");
      assert.equal(count(first.id), 3);
      await tick(t0 + day + 3);
      assert.equal(
        count(first.id),
        3,
        "manual retry must not reopen automatic retry window",
      );
      return {
        retry_window_ms: day,
        at_deadline_minus_1ms: { status: before.status, receiver_calls: 2 },
        at_deadline: {
          status: exact.status,
          error_code: exact.error_code,
          additional_receiver_calls: 0,
        },
        at_deadline_plus_1ms: {
          status: after.status,
          additional_receiver_calls: 0,
        },
        explicit_manual_retry_after_deadline: {
          http_status: manual.status,
          additional_receiver_calls: 1,
          automatic_window_reopened: false,
        },
        stable_delivery_id_and_first_pending_and_deadline: true,
        delivery_rows_inserted_by_production_fanout: true,
        scheduler: "production runWebhookRetryTick on actual D1/DO",
        time: "injected services.now; no 24h wall-clock wait",
      };
    });

    await observe("webhook-authorized-delivery-enumeration", async () => {
      assert.ok(failing, "independent subscription setup required");
      const expected = [
        await row(failing, "independent"),
        await row(failing, "after_cutover"),
        await row(failing, "boundary"),
      ];
      assert.ok(
        expected.every(Boolean),
        "fixture source deliveries must exist",
      );
      const seen = [];
      let cursor = null;
      do {
        const page = await api(
          `/api/v1/webhook-subscriptions/${failing.id}/deliveries?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        assert.equal(
          page.status,
          200,
          "authorized body-free delivery enumeration",
        );
        assert.ok(Array.isArray(page.body.items));
        assert.equal(page.body.items.length, 1);
        for (const item of page.body.items) {
          assert.equal(item.subscription_id, failing.id);
          for (const field of [
            "payload_json",
            "last_response_body",
            "text",
            "body",
          ])
            assert.equal(Object.hasOwn(item, field), false);
          assert.ok(
            !seen.includes(item.id),
            "delivery paging must make forward progress",
          );
          seen.push(item.id);
        }
        cursor = page.body.next_cursor;
        assert.ok(cursor === null || typeof cursor === "string");
        assert.ok(
          seen.length <= expected.length,
          "bounded fixture delivery enumeration",
        );
      } while (cursor !== null);
      assert.deepEqual(seen.sort(), expected.map((item) => item.id).sort());
      return {
        authorized_body_free_delivery_pages: seen.length,
        subscription_scoped: true,
        stable_ids: true,
      };
    });
  } finally {
    try {
      for (const subscription of created) {
        const result = await api(
          `/api/v1/webhook-subscriptions/${subscription.id}`,
          { idempotency_key: `integrated-webhook-cleanup-${subscription.id}` },
          {},
          "DELETE",
        );
        assert.equal(result.status, 200, "revoke local proof subscription");
      }
    } finally {
      if (grantCreated)
        await database
          .prepare(
            "DELETE FROM account_grants WHERE id = 'grant_integrated_webhook_proof'",
          )
          .run();
      assert.equal(
        (
          await database
            .prepare(
              "SELECT role FROM memberships WHERE id = 'membership_agent'",
            )
            .first()
        ).role,
        original.role,
      );
      calls.length = 0;
    }
  }
}
