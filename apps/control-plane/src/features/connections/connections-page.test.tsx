import { screen } from "@testing-library/react";
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

    await user.selectOptions(screen.getByLabelText("Active identity"), "identity_agent");

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
    expect(screen.getAllByRole("button", { name: /Simulation only.*Reconnect/i }).every(
      (button) => (button as HTMLButtonElement).disabled,
    )).toBe(true);
  });
});
