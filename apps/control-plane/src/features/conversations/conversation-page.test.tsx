import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { apiClient } from "@/lib/api/client";
import { simulatedStore } from "@/mocks/store";

describe("conversation journeys", () => {
  it("labels the active thread with identity, provider, and account", async () => {
    renderApp("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");

    expect(await screen.findByRole("heading", { name: "Alex Rivera", level: 1 })).toBeVisible();
    expect(screen.getByText("Human · telegram · Telegram")).toBeVisible();
    expect(screen.getByText("I sent the outline")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Back to conversations" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to conversations" })).toHaveClass("md:hidden");
    expect(screen.getByTestId("message-viewport")).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(screen.getByRole("heading", { name: "Alex Rivera", level: 1 }).closest("header"))
      .toHaveClass("sticky", "top-0", "z-[1]");
  });

  it("keeps attention-required history readable and disables sending", async () => {
    await apiClient.resetSimulation("attention_required");
    renderApp("/conversations/conversation_human_messenger_studio?identity=identity_human&channel=connection_human_messenger");

    expect(await screen.findByText("The render is ready")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Delivery mode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Sending is unavailable until this connection is repaired.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage connection" })).toHaveAttribute(
      "href",
      "/connections?identity=identity_human",
    );
  });

  it("shows one generic unavailable state for a cross-channel URL guess", async () => {
    renderApp("/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_telegram");

    expect(await screen.findByRole("alert")).toHaveTextContent("This conversation is unavailable.");
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to All" })).toBeVisible();
  });

  it("keeps the inbox and timeline scoped to the selected identity", async () => {
    const user = userEvent.setup();
    renderApp("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");

    expect(await screen.findByText("I sent the outline")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Active identity"), "identity_agent");

    expect(await screen.findByRole("link", { name: /Agent Test Chat/ })).toBeVisible();
    expect(screen.queryByText("Alex Rivera")).not.toBeInTheDocument();
  });

  it("accepts one simulated direct command and previews Human-paced delivery", async () => {
    const user = userEvent.setup();
    simulatedStore.reset();
    renderApp("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");

    expect(await screen.findByRole("heading", { name: "Alex Rivera", level: 1 })).toBeVisible();
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
    expect(simulatedStore.commands("identity_human")).toHaveLength(3);

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
  });
});
