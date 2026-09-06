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

  it("gives Conversations the full-bleed content area", async () => {
    renderApp("/conversations?identity=identity_human");

    expect(await screen.findByRole("heading", { name: "All conversations" })).toBeVisible();
    const main = screen.getByRole("main");
    expect(main).toHaveClass("min-h-0", "overflow-hidden", "p-0");
    expect(main).not.toHaveClass("lg:p-8");
  });

  it("keeps the global app header sticky above the bounded workspace", async () => {
    renderApp("/conversations?identity=identity_human");

    expect(await screen.findByRole("heading", { name: "All conversations" })).toBeVisible();
    expect(screen.getAllByRole("banner")[0]).toHaveClass("sticky", "top-0", "z-10");
  });
});
