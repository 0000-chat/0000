import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { simulatedStore } from "@/mocks/store";

describe("ConnectionsPage", () => {
  it("switches connections symmetrically with the active identity", async () => {
    const user = userEvent.setup();
    renderApp("/connections");

    expect(await screen.findByText("Personal WhatsApp")).toBeVisible();
    expect(screen.queryByText("Agent WhatsApp")).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Active identity"),
      "identity_agent",
    );

    expect(await screen.findByText("Agent WhatsApp")).toBeVisible();
    expect(screen.queryByText("Personal WhatsApp")).not.toBeInTheDocument();
  });

  it("shows capabilities and safe disabled controls for attention-required connections", async () => {
    simulatedStore.reset("attention_required");
    renderApp("/connections");

    expect(await screen.findByText("Action required")).toBeVisible();
    expect(screen.getAllByText("WhatsApp").length).toBeGreaterThan(0);
    expect(screen.getByText("Attention Required")).toBeVisible();
    expect(screen.getAllByText("message.send").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("button", { name: "Disconnect" })
        .some((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Unlink" })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it("creates, narrows, and revokes a grant for the selected agent target", async () => {
    const user = userEvent.setup();
    renderApp("/connections");

    expect(
      await screen.findByRole("heading", { name: "Account access grants" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: /Agent · Agent \(agent\)/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Load more accounts" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Load more accounts" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Identity"),
      "membership_agent:identity_agent",
    );
    await user.selectOptions(
      screen.getByLabelText("Connected account"),
      "account_connection_human_whatsapp",
    );
    await user.click(screen.getByRole("button", { name: "Grant access" }));

    expect(await screen.findByText("Agent · Personal WhatsApp")).toBeVisible();
    expect(simulatedStore.accountGrants()).toHaveLength(1);
    expect(simulatedStore.accountGrants()[0]).toMatchObject({
      membership_id: "membership_agent",
      identity_id: "identity_agent",
      account_id: "account_connection_human_whatsapp",
      chat_scope: "all_chats",
    });

    await user.click(screen.getByRole("button", { name: "Narrow" }));
    expect(
      await screen.findByText("Select chats for narrowed access"),
    ).toBeVisible();
    const chat = await screen.findByRole("checkbox", {
      name: /Family \(conversation_human_whatsapp_family\)/,
    });
    await user.click(chat);
    await user.click(
      screen.getByRole("button", { name: "Save narrowed access" }),
    );
    await waitFor(() =>
      expect(simulatedStore.accountGrants()[0]?.chat_scope).toBe(
        "selected_chats",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(simulatedStore.accountGrants()[0]?.status).toBe("revoked"),
    );
  });

  it("loads additional accounts while keeping the selected account and chat IDs stable", async () => {
    const user = userEvent.setup();
    renderApp("/connections");

    expect(
      await screen.findByRole("button", { name: "Load more accounts" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Load more accounts" }),
    );
    const account = await screen.findByLabelText("Connected account");
    await user.selectOptions(account, "account_connection_human_whatsapp");
    await user.selectOptions(
      screen.getByLabelText("Identity"),
      "membership_agent:identity_agent",
    );
    await user.selectOptions(
      screen.getByLabelText("Chat scope"),
      "selected_chats",
    );

    const chat = await screen.findByRole("checkbox", {
      name: /Family \(conversation_human_whatsapp_family\)/,
    });
    expect(chat).toBeVisible();
    await user.click(chat);
    await user.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() =>
      expect(simulatedStore.accountGrants()[0]).toMatchObject({
        account_id: "account_connection_human_whatsapp",
        identity_id: "identity_agent",
        chat_scope: "selected_chats",
        chat_ids: ["conversation_human_whatsapp_family"],
      }),
    );
  });
});
