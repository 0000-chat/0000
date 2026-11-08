import assert from "node:assert/strict";

const origin = "https://retention.integrated.test";
const classes = {
  projection_backup: "message",
  synapse: "message",
  bridge_database: "bridge_mapping",
  media_store: "attachment",
  queue: "queue_item",
  restic_snapshot: "message",
  session_credentials: "session_credential",
  account_keys: "account_key",
};
const auxiliary = (store) =>
  store === "session_credentials" || store === "account_keys";
const method = (store) =>
  auxiliary(store)
    ? "preserve"
    : store === "restic_snapshot"
      ? "age_out"
      : "delete";

// These finite, local stores are NOT inventories of the sidecar's Matrix DB,
// production backups, or real credentials. Each seed creates an actual owned
// copy here. Deleted records retain only lineage/tombstone metadata so later
// inventories can enumerate the same physical copy without retaining its body.
export function createRetentionFixture() {
  const stores = new Map(
    Object.keys(classes).map((store) => [store, new Map()]),
  );
  const tokens = new Map(
    Object.keys(classes).map((store) => [store, crypto.randomUUID()]),
  );
  const bindings = {};
  const calls = [];
  for (const store of stores.keys()) {
    const prefix = `COMMUNICATOR_RETENTION_${store.toUpperCase()}`;
    bindings[`${prefix}_URL`] = `${origin}/${store}`;
    bindings[`${prefix}_TOKEN`] = tokens.get(store);
    bindings[`${prefix}_OWNER`] = `integrated-local-${store}`;
  }

  function seedCopy(
    store,
    {
      tenant_id,
      resource_id,
      content_generation,
      reference,
      restore_target,
      copy_created_at = new Date().toISOString(),
    },
    content,
  ) {
    assert.ok(stores.has(store), "unknown controlled store");
    for (const value of [tenant_id, resource_id, content_generation, reference])
      assert.ok(typeof value === "string" && value.trim() && value !== "*");
    assert.ok(Number.isFinite(Date.parse(copy_created_at)));
    assert.notEqual(
      content,
      undefined,
      "a copy must contain actual local fixture data",
    );
    assert.notEqual(content, null);
    assert.ok(
      !stores.get(store).has(reference),
      "cannot overwrite an existing copy or tombstone",
    );
    if (restore_target) {
      assert.equal(restore_target.resource_id, resource_id);
      assert.equal(restore_target.content_generation, content_generation);
    }
    stores.get(store).set(reference, {
      tenant_id,
      inventory: structuredClone({
        reference,
        resource_id,
        content_generation,
        copy_created_at,
        content_class: classes[store],
        ...(restore_target ? { restore_target } : {}),
      }),
      content: structuredClone(content),
    });
  }

  async function outboundService(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return null;
    const [, store, operation, extra] = url.pathname.split("/");
    if (
      !stores.has(store) ||
      extra ||
      !["inventory", "cleanup"].includes(operation)
    )
      return Response.json({ error: "not_found" }, { status: 404 });
    if (request.headers.get("authorization") !== `Bearer ${tokens.get(store)}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json();
    if (
      body.protocol !== "controlled-copy-v1" ||
      body.store !== store ||
      body.operation !== operation
    )
      return Response.json({ error: "invalid_contract" }, { status: 400 });
    const records = stores.get(store);
    if (operation === "inventory") {
      const scope = body.scope;
      if (
        !scope ||
        typeof scope.tenant_id !== "string" ||
        typeof scope.resource_id !== "string" ||
        typeof scope.content_generation !== "string"
      )
        return Response.json({ error: "invalid_scope" }, { status: 400 });
      const copies = [...records.values()]
        .filter(
          (record) =>
            record.tenant_id === scope.tenant_id &&
            (scope.resource_type === "tenant" ||
              (record.inventory.resource_id === scope.resource_id &&
                record.inventory.content_generation ===
                  scope.content_generation)),
        )
        .map((record) => structuredClone(record.inventory));
      calls.push({ store, operation, copies: copies.length });
      return Response.json({
        complete: true,
        copies,
        evidence_source: `integrated-local-${store}-finite-map`,
        detail: copies.length
          ? null
          : "Finite local fixture store has no matching copies",
      });
    }
    const record = records.get(body.reference);
    if (
      !record ||
      record.inventory.resource_id !== body.resource_id ||
      record.inventory.content_generation !== body.content_generation ||
      record.inventory.content_class !== body.content_class ||
      body.deletion_method !== method(store)
    )
      return Response.json(
        { error: "unknown_copy_or_lineage" },
        { status: 409 },
      );
    const wasPresent = record.content !== undefined;
    if (!auxiliary(store)) delete record.content;
    const present = record.content !== undefined;
    assert.equal(present, auxiliary(store));
    calls.push({
      store,
      operation,
      was_present: wasPresent,
      content_present: present,
    });
    return Response.json({
      status: auxiliary(store)
        ? "preserved"
        : store === "restic_snapshot"
          ? "aged_out"
          : "deleted",
      content_present: present,
      evidence_source: `integrated-local-${store}-map-mutation`,
      object_reference: body.reference,
      detail: null,
    });
  }

  function facts() {
    return Object.fromEntries(
      [...stores].map(([store, records]) => [
        store,
        {
          copies: records.size,
          content_present: [...records.values()].filter(
            (record) => record.content !== undefined,
          ).length,
        },
      ]),
    );
  }
  return { bindings, outboundService, seedCopy, facts, calls };
}
