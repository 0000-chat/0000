import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

describe("ConversationList", () => {
  it("keeps compact rows distinct with provider branding, account labels, previews, and unread counts", async () => {
    renderApp("/conversations?identity=identity_human");

    const rows = await screen.findAllByTestId("conversation-row");
    const telegramRow = rows.find((row) => row.getAttribute("data-channel-id") === "connection_human_telegram");
    const whatsappRow = rows.find((row) => row.getAttribute("data-channel-id") === "connection_human_whatsapp");

    expect(telegramRow).toBeDefined();
    expect(whatsappRow).toBeDefined();
    expect(within(telegramRow!).getByTestId("provider-icon-telegram")).toBeInTheDocument();
    expect(within(telegramRow!).getByText("Telegram")).toBeVisible();
    expect(within(telegramRow!).getByText("I sent the outline")).toBeVisible();
    expect(within(telegramRow!).getByLabelText("3 unread")).toBeVisible();
    expect(within(whatsappRow!).getByTestId("provider-icon-whatsapp")).toBeInTheDocument();
    expect(within(whatsappRow!).getByText("Personal WhatsApp")).toBeVisible();
  });
});
