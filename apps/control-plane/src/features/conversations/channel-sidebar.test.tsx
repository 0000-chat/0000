import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "@communicator/contracts";
import { ChannelSidebar } from "./channel-sidebar";

const channels: ChannelSummary[] = [
  {
    id: "connection_human_whatsapp",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "whatsapp",
    display_label: "Personal WhatsApp",
    status: "ready",
    capabilities: ["message.send"],
    unread_count: 5,
    last_activity_at: "2026-08-28T00:01:00.000Z",
    sort_position: 10,
  },
  {
    id: "connection_human_telegram",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "telegram",
    display_label: "Telegram",
    status: "ready",
    capabilities: ["message.send"],
    unread_count: 3,
    last_activity_at: "2026-08-28T00:03:00.000Z",
    sort_position: 20,
  },
  {
    id: "connection_human_messenger",
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    provider: "messenger",
    display_label: "Messenger",
    status: "attention_required",
    capabilities: ["message.send"],
    unread_count: 2,
    last_activity_at: null,
    sort_position: 30,
    attention_code: "reauth_required",
  },
];

describe("ChannelSidebar", () => {
  it("renders All first, uses supplied order, and exposes unread totals", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onReorder = vi.fn();
    render(
      <ChannelSidebar
        channels={channels}
        identityId="identity_human"
        selectedChannelId="connection_human_telegram"
        allUnreadCount={10}
        onSelect={onSelect}
        onReorder={onReorder}
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Conversation channels",
    });
    expect(screen.getByText("Channels")).toBeVisible();
    expect(navigation.querySelector("button")).toHaveTextContent("All");
    expect(screen.getByRole("button", { name: /All/ })).toHaveTextContent("10");
    expect(
      screen.getByRole("button", { name: "Select Telegram" }),
    ).toHaveTextContent("telegram");
    expect(
      screen.getByRole("button", { name: "Select Telegram" }),
    ).toHaveTextContent("Telegram");
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(screen.getByText("Attention required")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Manage connection" }),
    ).toHaveAttribute("href", "/connections?identity=identity_human");

    await user.click(screen.getByRole("button", { name: "Select Telegram" }));
    expect(onSelect).toHaveBeenCalledWith("connection_human_telegram");

    const reorderTelegram = screen.getByRole("button", {
      name: "Reorder Telegram",
    });
    reorderTelegram.focus();
    await user.keyboard("[Space]");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("[Space]");
    expect(onReorder).toHaveBeenCalledWith([
      "connection_human_telegram",
      "connection_human_whatsapp",
      "connection_human_messenger",
    ]);
    expect(
      screen.queryByRole("button", { name: /Move .* (up|down)/ }),
    ).not.toBeInTheDocument();
  });
});
