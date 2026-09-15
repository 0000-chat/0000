import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/mocks/server";
import {
  loadChannelOrder,
  saveChannelOrder,
} from "@/features/conversations/channel-order";
import { runtimeRealtimeClient } from "@/lib/realtime/runtime-client";

afterEach(() => {
  runtimeRealtimeClient?.close();
  runtimeRealtimeClient?.reset();
  vi.restoreAllMocks();
});

beforeEach(() => {
  server.use(
    http.get("http://localhost:3000/api/v1/health", () =>
      HttpResponse.json({
        status: "ok",
        service: "communicator-control-plane",
        data_mode: "simulated",
      }),
    ),
  );
});

describe("diagnostic surfaces", () => {
  it("shows API health, simulated data mode, and realtime diagnostics", async () => {
    renderApp("/system");

    expect(await screen.findByText("API health")).toBeVisible();
    expect(await screen.findByText("ok")).toBeVisible();
    expect(screen.getByText("simulated")).toBeVisible();
    expect(await screen.findByText("Connected")).toBeVisible();
    expect(screen.getByText("Last sequence")).toBeVisible();
    expect(screen.getByText("Fixture reset time")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Reset simulated scenario" }),
    ).toBeVisible();
  });

  it("shows a bounded status and connects with the authenticated active identity", async () => {
    const connect = vi.spyOn(runtimeRealtimeClient!, "connect");
    renderApp("/system");

    expect(await screen.findByText("Connected")).toBeVisible();
    expect(connect).toHaveBeenCalledWith({
      tenantId: "tenant_pilot",
      principalId: "principal_pilot",
      identityIds: ["identity_human"],
      families: ["projection"],
    });
    expect(document.body.textContent).not.toMatch(
      /ticket|wss?:|bearer|access/i,
    );
  });

  it("resets the simulated scenario through a labelled diagnostic control", async () => {
    const user = userEvent.setup();
    renderApp("/system");

    const reset = await screen.findByRole("button", {
      name: "Reset simulated scenario",
    });
    await user.click(reset);
    expect(
      await screen.findByRole("status", { name: "Simulation reset complete" }),
    ).toBeVisible();
  });

  it("clears channel order preferences when the simulation resets", async () => {
    saveChannelOrder("principal_pilot", "identity_human", [
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([
      "connection_human_telegram",
      "connection_human_whatsapp",
    ]);

    const user = userEvent.setup();
    renderApp("/system");
    await user.click(
      await screen.findByRole("button", { name: "Reset simulated scenario" }),
    );
    await screen.findByRole("status", { name: "Simulation reset complete" });
    expect(loadChannelOrder("principal_pilot", "identity_human")).toEqual([]);
  });

  it("shows command phases and an overview summary with links to every screen", async () => {
    renderApp("/activity");

    const activity = await screen.findByRole("list", {
      name: "Command activity",
    });
    expect(await within(activity).findAllByText("message.send")).toHaveLength(
      2,
    );
    expect(within(activity).getByText("Human")).toBeVisible();
    expect(within(activity).getByText("Agent")).toBeVisible();
    expect(within(activity).getByText("Direct")).toBeVisible();
    expect(within(activity).getByText("Human-paced")).toBeVisible();
    expect(within(activity).getByText("Delivered")).toBeVisible();
    expect(within(activity).getByText("Scheduled")).toBeVisible();
    expect(within(activity).queryByText(/matrix/i)).not.toBeInTheDocument();

    renderApp("/");
    expect(await screen.findByText("3 connections")).toBeVisible();
    expect(screen.getByText("1 command")).toBeVisible();
    for (const linkName of [
      "Connections",
      "Conversations",
      "Activity",
      "System",
    ]) {
      expect(
        screen.getAllByRole("link", { name: linkName }).length,
      ).toBeGreaterThan(0);
    }
  });
});
