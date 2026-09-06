import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { pilotScenario } from "@communicator/test-fixtures";
import { renderApp } from "@/test/render-app";

describe("ConversationsShell", () => {
  it("defaults to All and renders every Human conversation in global recency order", async () => {
    renderApp("/conversations?identity=identity_human");

    expect(await screen.findByRole("heading", { name: "Channels" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "All conversations" })).toBeVisible();
    const allButtons = await screen.findAllByRole("button", { name: /All/ });
    expect(allButtons.find((button) => button.getAttribute("aria-current") === "page")).toBeVisible();
    const rows = await screen.findAllByTestId("conversation-row");
    expect(rows.map((row) => row.getAttribute("data-conversation-id"))).toEqual([
      "conversation_human_telegram_alex",
      "conversation_human_whatsapp_family",
      "conversation_human_messenger_studio",
      "conversation_human_whatsapp_alex",
      "conversation_human_telegram_product",
      "conversation_human_messenger_archive",
    ]);
  });

  it("filters the conversation list to the selected channel", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/conversations?identity=identity_human");

    await user.click(await screen.findByRole("button", { name: "Select Telegram" }));
    await waitFor(() => expect(router.state.location.search).toEqual({
      identity: "identity_human",
      channel: "connection_human_telegram",
    }));
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(2);
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("keeps same-name contacts as separate channel-labelled rows in All", async () => {
    renderApp("/conversations?identity=identity_human");
    const alexRows = await screen.findAllByRole("link", { name: /Alex Rivera/ });
    expect(alexRows).toHaveLength(2);
    expect(alexRows[0]).toHaveTextContent(/Telegram|Personal WhatsApp/);
    expect(alexRows[1]).toHaveTextContent(/Telegram|Personal WhatsApp/);
  });

  it("reports an empty channel set with an accessible status", async () => {
    server.use(http.get("*/api/v1/identities/identity_human/channels", () => HttpResponse.json([])));
    renderApp("/conversations?identity=identity_human");
    expect(await screen.findByText("No channels are available for this identity.")).toBeVisible();
  });

  it("reports an empty selected channel without showing unrelated conversations", async () => {
    server.use(http.get("*/api/v1/identities/identity_human/conversations", ({ request }) => {
      if (new URL(request.url).searchParams.get("channel_id") !== "connection_human_telegram") {
        return passthroughResponse();
      }
      return HttpResponse.json({ items: [], next_cursor: null });
    }));
    renderApp("/conversations?identity=identity_human&channel=connection_human_telegram");
    expect(await screen.findByText("No conversations are available for this channel.")).toBeVisible();
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("retries a conversation request after a simulated server error", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(http.get("*/api/v1/identities/identity_human/conversations", ({ request }) => {
      if (new URL(request.url).searchParams.has("channel_id")) return passthroughResponse();
      attempts += 1;
      return attempts === 1
        ? HttpResponse.json({ error: { code: "server_error", message: "Unavailable" } }, { status: 500 })
        : HttpResponse.json({
          items: pilotScenario.conversations.filter((item) => item.identity_id === "identity_human"),
          next_cursor: null,
        });
    }));

    renderApp("/conversations?identity=identity_human");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load conversations");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("conversation-row")).toHaveLength(6);
  });
});

function passthroughResponse() {
  return HttpResponse.json({ items: [], next_cursor: null });
}
