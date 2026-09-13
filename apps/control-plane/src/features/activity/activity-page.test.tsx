import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Command } from "@communicator/contracts";
import { renderApp } from "@/test/render-app";
import { server } from "@/mocks/server";

const waitingCommand: Command = {
  id: "command_other_chat",
  tenant_id: "tenant_pilot",
  identity_id: "identity_agent",
  resource_identity_id: "identity_human",
  account_id: "account_human_whatsapp",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_other_chat",
  message_id: "message_other_chat",
  event_id: "event_other_chat",
  dispatch_id: "dispatch_other_chat",
  actor_principal_id: "principal_agent",
  actor_identity_id: "identity_agent",
  operation: "message.send",
  delivery_mode: "direct",
  status: "waiting_for_connection",
  created_at: "2026-08-29T00:00:00.000Z",
  updated_at: "2026-08-29T00:00:00.000Z",
  confirmation_due_at: "2026-08-29T04:00:00.000Z",
};

const reviewCommand: Command = {
  id: "command_offline_review",
  tenant_id: "tenant_pilot",
  identity_id: "identity_agent",
  resource_identity_id: "identity_human",
  account_id: "account_human_whatsapp",
  connection_id: "connection_human_whatsapp",
  conversation_id: "conversation_review_chat",
  message_id: "message_offline_review",
  event_id: "event_offline_review",
  dispatch_id: "dispatch_offline_review",
  actor_principal_id: "principal_agent",
  actor_identity_id: "identity_agent",
  operation: "message.send",
  delivery_mode: "direct",
  status: "confirmation_required",
  created_at: "2026-08-29T00:30:00.000Z",
  updated_at: "2026-08-29T04:30:00.000Z",
  confirmation_due_at: "2026-08-29T04:30:00.000Z",
};

function dispatchFor(command: Command, decision: "confirm" | "cancel") {
  return {
    id: command.dispatch_id!,
    tenant_id: command.tenant_id,
    command_id: command.id,
    message_id: command.message_id!,
    event_id: command.event_id!,
    actor_principal_id: command.actor_principal_id!,
    actor_identity_id: command.actor_identity_id!,
    resource_identity_id: command.resource_identity_id!,
    account_id: command.account_id!,
    connection_id: command.connection_id!,
    conversation_id: command.conversation_id,
    idempotency_key: `activity-${command.id}-${decision}`,
    status: decision === "cancel" ? "cancelled" : "pending",
    created_at: command.created_at,
    updated_at: command.updated_at,
    confirmation_due_at: command.confirmation_due_at,
    confirmation_decision: decision,
    confirmation_actor_principal_id: command.confirmation_actor_principal_id,
    confirmation_actor_identity_id: command.confirmation_actor_identity_id,
    confirmation_decided_at: command.confirmation_decided_at,
  };
}

describe("administrator activity", () => {
  it("shows saved message context and controls the selected command among chats", async () => {
    const user = userEvent.setup();
    let commands = [waitingCommand, reviewCommand];
    const decisions: string[] = [];
    server.use(
      http.get("*/api/v1/commands", () => HttpResponse.json(commands)),
      http.post(
        "*/api/v1/commands/:commandId/:decision",
        async ({ request, params }) => {
          const decision = String(params.decision) as "confirm" | "cancel";
          const body = (await request.json()) as {
            idempotency_key: string;
          };
          decisions.push(`${String(params.commandId)}:${body.idempotency_key}`);
          commands = commands.map((command) =>
            command.id !== String(params.commandId)
              ? command
              : {
                  ...command,
                  status: decision === "cancel" ? "cancelled" : "accepted",
                  updated_at: "2026-08-29T05:00:00.000Z",
                  confirmation_decision: decision,
                  confirmation_actor_principal_id: "principal_pilot",
                  confirmation_actor_identity_id: "identity_human",
                  confirmation_decided_at: "2026-08-29T05:00:00.000Z",
                },
          );
          const command = commands.find(
            (candidate) => candidate.id === String(params.commandId),
          )!;
          return HttpResponse.json({
            command,
            dispatch: dispatchFor(command, decision),
            replayed: false,
          });
        },
      ),
    );

    renderApp("/activity");

    expect(
      await screen.findByRole("link", {
        name: "Open saved message message_offline_review",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "Open saved message message_other_chat",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Original save")).toHaveLength(2);
    expect(screen.getAllByText("Confirmation due")).toHaveLength(2);
    expect(screen.getAllByText("Account")).toHaveLength(2);
    expect(screen.getAllByText("Account identity")).toHaveLength(2);

    const reviewCard = screen
      .getByRole("link", {
        name: "Open saved message message_offline_review",
      })
      .closest("li");
    const waitingCard = screen
      .getByRole("link", { name: "Open saved message message_other_chat" })
      .closest("li");
    expect(reviewCard).not.toBeNull();
    expect(waitingCard).not.toBeNull();
    expect(within(reviewCard!).getByText("Human")).toBeVisible();
    expect(within(waitingCard!).getByText("Human")).toBeVisible();
    expect(
      within(reviewCard!).getByRole("button", { name: "Confirm dispatch" }),
    ).toBeVisible();
    expect(
      within(reviewCard!).getByRole("button", { name: "Cancel dispatch" }),
    ).toBeVisible();
    expect(
      within(waitingCard!).queryByRole("button", {
        name: "Confirm dispatch",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(reviewCard!).getByRole("link", {
        name: "Open saved message message_offline_review",
      }),
    ).toHaveAttribute(
      "href",
      "/conversations/conversation_review_chat?identity=identity_human&message=message_offline_review#message_offline_review",
    );

    await user.click(
      within(reviewCard!).getByRole("button", { name: "Cancel dispatch" }),
    );
    await waitFor(() =>
      expect(decisions).toEqual([
        "command_offline_review:activity-command_offline_review-cancel",
      ]),
    );
    expect(
      await screen.findByText(
        "This saved command was cancelled by the recorded decision actor.",
      ),
    ).toBeVisible();
    expect(screen.getByText("principal_pilot (Human)")).toBeVisible();
  });

  it("shows a stale decision rejection with a refresh control", async () => {
    server.use(
      http.get("*/api/v1/commands", () => HttpResponse.json([reviewCommand])),
      http.post("*/api/v1/commands/:commandId/:decision", () =>
        HttpResponse.json(
          {
            error: {
              code: "invalid_request",
              message: "Decision is stale",
            },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp("/activity");

    await user.click(
      await screen.findByRole("button", { name: "Confirm dispatch" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Decision rejected",
    );
    expect(
      screen.getByRole("button", { name: "Refresh activity" }),
    ).toBeVisible();
  });
});
