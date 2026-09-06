import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "@communicator/contracts";
import { SortableChannelList } from "./sortable-channel-list";

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
];

function renderList(onReorder = vi.fn()) {
  render(
    <SortableChannelList
      channels={channels}
      selectedChannelId="connection_human_telegram"
      allUnreadCount={8}
      onSelect={vi.fn()}
      onReorder={onReorder}
      manageConnectionHref="/connections?identity=identity_human"
    />,
  );
  return onReorder;
}

describe("SortableChannelList", () => {
  it("keeps All first and excludes it from sortable handles", () => {
    renderList();

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("All");
    expect(screen.getByRole("button", { name: "Reorder Personal WhatsApp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reorder Telegram" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move .* (up|down)/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All/ })).not.toHaveAttribute("aria-roledescription");
  });

  it("moves a channel through the existing reorder callback with keyboard sorting", async () => {
    const user = userEvent.setup();
    const onReorder = renderList();
    const handle = screen.getByRole("button", { name: "Reorder Telegram" });
    const rows = screen.getAllByRole("listitem");
    rows.forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        bottom: 56 + index * 56,
        height: 56,
        left: 0,
        right: 280,
        top: index * 56,
        width: 280,
        x: 0,
        y: index * 56,
        toJSON: () => ({}),
      });
    });

    handle.focus();
    await user.keyboard("[Space]");
    await user.keyboard("{ArrowUp}");
    expect(onReorder).not.toHaveBeenCalled();
    await user.keyboard("[Space]");

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);
    expect(screen.getByText(/Use Space to pick up/)).toBeInTheDocument();
  });

  it("does not persist a keyboard reorder when sorting is cancelled", async () => {
    const user = userEvent.setup();
    const onReorder = renderList();
    const handle = screen.getByRole("button", { name: "Reorder Telegram" });
    const rows = screen.getAllByRole("listitem");
    rows.forEach((row, index) => {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        bottom: 56 + index * 56,
        height: 56,
        left: 0,
        right: 280,
        top: index * 56,
        width: 280,
        x: 0,
        y: index * 56,
        toJSON: () => ({}),
      });
    });

    handle.focus();
    await user.keyboard("[Space]");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Escape}");

    expect(onReorder).not.toHaveBeenCalled();
  });
});
