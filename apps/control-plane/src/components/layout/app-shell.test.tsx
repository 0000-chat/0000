import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

describe("AppShell", () => {
  it("exposes the primary navigation and active identity context", async () => {
    renderApp("/connections");

    for (const name of [
      "Overview",
      "Connections",
      "Conversations",
      "Activity",
      "System",
    ]) {
      expect(await screen.findByRole("link", { name })).toBeVisible();
    }
    expect(screen.getByText(/SIMULATED DATA/)).toBeVisible();
    expect(screen.getByLabelText("Active identity")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeVisible();
  });
});
