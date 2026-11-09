import assert from "node:assert/strict";
import fs from "node:fs";

// The file controls only the external Matrix observation endpoint. Status is
// never supplied to the Worker; it derives its saved tuple and asks the actual
// gateway to authenticate the Matrix event against its protected journal.
export async function runEvidenceProof({
  observe,
  serviceApi,
  humanApi,
  accepted,
  evidencePath,
  calls,
}) {
  const command = accepted.body;
  assert.equal(accepted.status, 202);
  const input = (id) => ({
    schema_version: 1,
    tenant_id: "tenant_pilot",
    command_id: command.id,
    observation_event_id: `$integrated-${id}:example.test`,
  });
  const endpoint = "/internal/v1/outbound/provider-evidence";
  const select = (kind) =>
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({ transaction_id: command.transaction_id, kind }),
      { mode: 0o600 },
    );
  await observe("provider-evidence-caller-status-denied", async () => {
    const before = await calls();
    const result = await serviceApi(endpoint, {
      ...input("caller-status"),
      status: "delivered",
    });
    assert.equal(result.status, 400);
    assert.equal((await calls()).evidence_requests, before.evidence_requests);
    return {
      http_status: 400,
      caller_cannot_supply_delivery_status: true,
      additional_matrix_observations: 0,
    };
  });
  for (const kind of ["forged", "wrong_reference"]) {
    await observe(`provider-evidence-${kind}-denied`, async () => {
      select(kind);
      const result = await serviceApi(endpoint, input(kind));
      // Native normalize_status classifies forged authors and wrong journal
      // references as correlation conflicts, not unsupported event formats.
      assert.equal(result.status, 409);
      assert.equal(result.body.error, "provider_evidence_unavailable");
      const saved = await humanApi(`/api/v1/commands/${command.id}`);
      assert.equal(saved.body.command.provider_stage, "unknown");
      return {
        http_status: result.status,
        controlled_matrix_observation_rejected: true,
        provider_stage_unchanged: true,
      };
    });
  }
  await observe(
    "provider-evidence-bridge-acceptance-not-delivery",
    async () => {
      select("accepted");
      const result = await serviceApi(endpoint, input("accepted"));
      assert.equal(result.status, 200);
      assert.equal(result.body.provider_stage, "unknown");
      assert.equal(result.body.bridge_stage, "accepted");
      assert.equal(result.body.provider_read, "unsupported");
      return {
        http_status: 200,
        bridge_stage: result.body.bridge_stage,
        provider_stage: result.body.provider_stage,
        provider_read: "unsupported",
      };
    },
  );
  await observe("provider-evidence-authenticated-dm-delivery", async () => {
    const before = await calls();
    select("delivered");
    const result = await serviceApi(endpoint, input("delivered"));
    assert.equal(result.status, 200);
    assert.equal(result.body.provider_stage, "delivered");
    assert.equal(result.body.provider_read, "unsupported");
    const saved = await humanApi(`/api/v1/commands/${command.id}`);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.command.provider_stage, "delivered");
    assert.equal((await calls()).send_requests, before.send_requests);
    assert.equal((await calls()).receipt_requests, before.receipt_requests);
    return {
      http_status: 200,
      provider_stage: "delivered",
      scope:
        "controlled authenticated bridge-reported DM delivery; not real WhatsApp delivery",
      provider_read: "unsupported",
      additional_matrix_sends: 0,
      additional_matrix_receipts: 0,
    };
  });
}
