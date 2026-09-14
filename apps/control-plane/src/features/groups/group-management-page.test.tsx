import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type {
  GroupManagementEvidence,
  GroupManagementOperation,
} from "@communicator/contracts";
import { server } from "@/mocks/server";
import { renderApp } from "@/test/render-app";

const operation: GroupManagementOperation = {
  operation_id: "group_manage_ui_1",
  tenant_id: "tenant_pilot",
  membership_id: "membership_pilot",
  identity_id: "identity_human",
  account_id: "account_connection_human_whatsapp",
  connection_id: "connection_human_whatsapp",
  provider: "whatsapp",
  conversation_id: "conversation_group_ui",
  provider_group_id: "provider_group_ui",
  matrix_room_id: "!group-ui:example.test",
  action: "rename",
  requested_name: "Operations",
  requested_member_provider_ids: [],
  expected_revision: "4",
  status: "succeeded",
  result_revision: "5",
  result_member_provider_ids: ["lid_alice", "lid_bob"],
  current_name: "Operations",
  current_revision: "5",
  current_member_provider_ids: ["lid_alice", "lid_bob"],
  evidence: null,
  evidence_path: "provider",
  duplicate_risk: false,
  human_action_required: false,
  failure_code: null,
  created_at: "2026-08-29T00:00:00.000Z",
  updated_at: "2026-08-29T00:01:00.000Z",
};

const evidence: GroupManagementEvidence = {
  source: "provider",
  evidence_id: "evidence_group_ui_1",
  observed_at: "2026-08-29T00:01:00.000Z",
  operation_id: operation.operation_id,
  account_id: operation.account_id,
  connection_id: operation.connection_id,
  provider_group_id: operation.provider_group_id,
  matrix_room_id: operation.matrix_room_id,
  revision: "5",
  name: "Operations",
  member_provider_ids: operation.current_member_provider_ids,
  status: "confirmed",
  reason: null,
  accepted: true,
};

describe("group management page", () => {
  it("shows status, current revision, members, and provider evidence", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/group-management/operations", () =>
        HttpResponse.json({ items: [operation], next_cursor: null }),
      ),
      http.get(
        "*/api/v1/group-management/operations/:operationId/evidence",
        () => HttpResponse.json([evidence]),
      ),
    );

    renderApp("/groups");

    expect(
      await screen.findByRole("heading", { name: "Group management" }),
    ).toBeVisible();
    const operationLabel = await screen.findByText(/group_manage_ui_1/);
    const card = operationLabel.closest(
      '[data-slot="card"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(within(card!).getByText("succeeded")).toBeVisible();
    expect(within(card!).getByText("5")).toBeVisible();
    expect(within(card!).getByText("lid_alice, lid_bob")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "View provider evidence" }),
    );
    expect(await screen.findByText(/evidence_group_ui_1/)).toBeVisible();
    expect(screen.getByText(/revision 5/)).toBeVisible();
  });
});
