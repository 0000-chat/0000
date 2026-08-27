import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { simulatedStore } from "@/mocks/store";

describe("conversation journeys", () => {
  it("keeps the inbox and timeline scoped to the selected identity", async () => {
    const user = userEvent.setup();
    renderApp("/conversations");

    expect(await screen.findByRole("link", { name: /Example Contact/ })).toBeVisible();
    expect(screen.getByRole("link", { name: /Example Customer/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Agent Test Chat/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Example Contact/ }));

    expect(await screen.findByRole("heading", { name: "Example Contact" })).toBeVisible();
    expect(screen.getByText("Hello from the example contact.")).toBeVisible();
    expect(screen.getByText("Hello from the simulated Human identity.")).toBeVisible();
    expect(screen.getByText("Thanks, that works for me.")).toBeVisible();
    expect(screen.getAllByText("Delivered").length).toBeGreaterThan(0);
    expect(screen.getByText("1 attachment")).toBeVisible();
    expect(screen.getByRole("list", { name: "Message timeline" })).toBeVisible();
  });

  it("turns a cross-identity conversation into the generic not-found state", async () => {
    const user = userEvent.setup();
    renderApp("/conversations/conversation_human_one");

    expect(await screen.findByRole("heading", { name: "Example Contact" })).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Active identity"), "identity_agent");

    expect(await screen.findByText("Conversation not found")).toBeVisible();
    expect(screen.queryByText("Hello from the example contact.")).not.toBeInTheDocument();
  });

  it("accepts one simulated direct command and previews Human-paced delivery", async () => {
    const user = userEvent.setup();
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    simulatedStore.reset();
    try {
      renderApp("/conversations/conversation_human_one");

      expect(await screen.findByRole("heading", { name: "Example Contact" })).toBeVisible();
      const composer = screen.getByRole("form", { name: "Send a message" });
      const sendButton = screen.getByRole("button", { name: "Send message" });
      expect(sendButton).toBeDisabled();

      await user.type(screen.getByRole("textbox", { name: "Message" }), "Hello from the simulated Human identity");
      await user.selectOptions(screen.getByRole("combobox", { name: "Delivery mode" }), "direct");
      expect(sendButton).toBeEnabled();
      await user.click(sendButton);

      expect(await screen.findByText("Accepted — awaiting messaging confirmation")).toBeVisible();
      expect(simulatedStore.commands("identity_human")).toHaveLength(2);
      expect(composer).toBeVisible();

      await user.type(screen.getByRole("textbox", { name: "Message" }), "Hello from the simulated Human identity");
      await user.click(sendButton);
      expect(await screen.findByText("Accepted — awaiting messaging confirmation")).toBeVisible();
      expect(simulatedStore.commands("identity_human")).toHaveLength(2);

      await user.selectOptions(screen.getByRole("combobox", { name: "Delivery mode" }), "paced");
      expect(screen.getByText("Human-paced preview")).toBeVisible();
      for (const phase of [
        "Mark read (when supported)",
        "Reading delay",
        "Typing indicator",
        "Send message",
      ]) {
        expect(screen.getAllByText(phase).length).toBeGreaterThan(0);
      }
    } finally {
      randomUUID.mockRestore();
    }
  });
});
