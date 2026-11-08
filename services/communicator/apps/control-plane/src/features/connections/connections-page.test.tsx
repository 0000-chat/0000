import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { simulatedStore } from "@/mocks/store";
import { server } from "@/mocks/server";

describe("ConnectionsPage", () => {
  it("loads eligible identities beyond the first page and does not enable grants after denial", async () => {
    const user = userEvent.setup();
    const targets = simulatedStore.grantTargets();
    let denied = false;
    server.use(
      http.get("*/api/v1/grant-targets", ({ request }) => {
        if (denied)
          return HttpResponse.json(
            {
              error: { code: "forbidden", message: "Grant management denied" },
            },
            { status: 403 },
          );
        const more = new URL(request.url).searchParams.has("cursor");
        return HttpResponse.json({
          items: more ? targets.slice(1) : targets.slice(0, 1),
          next_cursor: more ? null : "next",
        });
      }),
    );
    const { queryClient } = renderApp("/connections");
    await user.click(
      await screen.findByRole("button", { name: "Load more identities" }),
    );
    expect(
      await screen.findByRole("option", { name: /Agent · Agent/ }),
    ).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("Identity"),
      "membership_agent:identity_agent",
    );
    expect(screen.getByLabelText("Identity")).toHaveValue(
      "membership_agent:identity_agent",
    );
    denied = true;
    await queryClient.invalidateQueries({ queryKey: ["grant-targets"] });
    expect(
      await screen.findByText("Unable to load account grant management data."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Grant access" }),
    ).not.toBeInTheDocument();
  });

  it("keeps create and narrow chat selections separate and clears a changed account", async () => {
    const user = userEvent.setup();
    renderApp("/connections");
    await user.click(
      await screen.findByRole("button", { name: "Load more accounts" }),
    );
    await user.selectOptions(
      screen.getByLabelText("Connected account"),
      "account_connection_human_whatsapp",
    );
    await user.click(screen.getByRole("button", { name: "Grant access" }));
    await screen.findByRole("button", { name: "Narrow" });
    await user.selectOptions(
      screen.getByLabelText("Chat scope"),
      "selected_chats",
    );
    await user.click(
      await screen.findByRole("checkbox", { name: /Family \(/ }),
    );
    await user.click(screen.getByRole("button", { name: "Narrow" }));
    expect(
      screen.getAllByRole("checkbox", { name: /Family \(/ })[0],
    ).toBeChecked();
    const createPicker = screen.getByRole("group", {
      name: "Chats for selected identity and account",
    });
    const narrowPicker = screen.getByRole("group", {
      name: "Select chats for narrowed access",
    });
    expect(
      within(createPicker).getByRole("checkbox", { name: /Family \(/ }),
    ).toBeChecked();
    expect(
      within(narrowPicker).getByRole("checkbox", { name: /Family \(/ }),
    ).not.toBeChecked();
    await user.selectOptions(
      screen.getByLabelText("Connected account"),
      "account_connection_human_telegram",
    );
    expect(
      await within(createPicker).findByRole("checkbox", {
        name: /conversation_human_telegram_alex/,
      }),
    ).toBeVisible();
    expect(
      within(createPicker).queryByRole("checkbox", { name: /Family \(/ }),
    ).not.toBeInTheDocument();
    expect(
      within(narrowPicker).getByRole("checkbox", { name: /Family \(/ }),
    ).not.toBeChecked();
    expect(screen.getByText("0 chats selected.")).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("Connected account"),
      "account_connection_human_whatsapp",
    );
    const createFamily = await within(createPicker).findByRole("checkbox", {
      name: /Family \(/,
    });
    expect(createFamily).not.toBeChecked();
    await user.click(createFamily);
    await user.click(
      within(narrowPicker).getByRole("checkbox", { name: /Family \(/ }),
    );
    await user.click(
      within(narrowPicker).getByRole("button", {
        name: "Save narrowed access",
      }),
    );
    await waitFor(() =>
      expect(simulatedStore.accountGrants()[0]?.chat_ids).toEqual([
        "conversation_human_whatsapp_family",
      ]),
    );
    expect(
      within(createPicker).getByRole("checkbox", { name: /Family \(/ }),
    ).toBeChecked();
  });

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
