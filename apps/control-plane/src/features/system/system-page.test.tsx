import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/mocks/server";

beforeEach(() => {
  server.use(http.get("http://localhost:3000/api/v1/health", () => HttpResponse.json({
    status: "ok",
    service: "communicator-control-plane",
    data_mode: "simulated",
  })));
});

describe("diagnostic surfaces", () => {
  it("shows API health, simulated data mode, and realtime diagnostics", async () => {
    renderApp("/system");

    expect(await screen.findByText("API health")).toBeVisible();
    expect(screen.getByText("ok")).toBeVisible();
    expect(screen.getByText("simulated")).toBeVisible();
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.getByText("Last sequence")).toBeVisible();
    expect(screen.getByText("Fixture reset time")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reset simulated scenario" })).toBeVisible();
  });

  it("resets the simulated scenario through a labelled diagnostic control", async () => {
    const user = userEvent.setup();
    renderApp("/system");

    const reset = await screen.findByRole("button", { name: "Reset simulated scenario" });
    await user.click(reset);
    expect(await screen.findByRole("status", { name: "Simulation reset complete" })).toBeVisible();
  });

  it("shows command phases and an overview summary with links to every screen", async () => {
    renderApp("/activity");

    expect(await screen.findByText("message.send")).toBeVisible();
    expect(screen.getByText("Human")).toBeVisible();
    expect(screen.getByText("Direct")).toBeVisible();
    expect(screen.getByText("Delivered")).toBeVisible();
    expect(screen.queryByText(/matrix/i)).not.toBeInTheDocument();

    renderApp("/");
    expect(await screen.findByText("1 connection")).toBeVisible();
    expect(screen.getByText("1 command")).toBeVisible();
    for (const linkName of ["Connections", "Conversations", "Activity", "System"]) {
      expect(screen.getAllByRole("link", { name: linkName }).length).toBeGreaterThan(0);
    }
  });
});
