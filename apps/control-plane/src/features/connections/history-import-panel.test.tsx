import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/mocks/server";
import { simulatedStore } from "@/mocks/store";

describe("HistoryImportPanel", () => {
  it("shows capability proof, partial and failed progress, and advances a batch through the handlers", async () => {
    const user = userEvent.setup();
    renderApp("/connections");

    expect(
      await screen.findByRole("heading", { name: "History imports" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", { name: "Load more linked accounts" }),
    ).toBeVisible();
    expect(await screen.findByText(/Partial coverage remains visible/)).toBeVisible();
    expect(await screen.findByText("Known gap: provider_gap")).toBeVisible();
    expect(await screen.findByText(/Bounded Retry Exhausted/)).toBeVisible();
    expect((await screen.findAllByText(/Proof: controlled provider fixture/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByRole("button", { name: "Start import" })).length).toBeGreaterThan(0);

    const start = screen.getByLabelText("History start for Messenger");
    const end = screen.getByLabelText("History end for Messenger");
    const form = start.closest("form");
    if (!form) throw new Error("History start form is missing");
    await user.type(start, "2026-08-01T00:00");
    await user.type(end, "2026-08-31T00:00");
    await user.click(within(form).getByRole("button", { name: "Start import" }));

    expect(await screen.findByText(/Import import_ui_1/)).toBeVisible();
    expect(simulatedStore.historyImportPage("account_connection_human_messenger", "identity_human"))
      .toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Advance next range" }));
    expect(simulatedStore.historyImport("import_ui_1", "identity_human")?.import.status).toBe("completed");
    expect((await screen.findAllByText(/4 events/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Completed")).length).toBeGreaterThan(0);
  });

  it("does not render start or advance controls for a non-administrator principal", async () => {
    const session = simulatedStore.session();
    server.use(
      http.get("*/api/v1/session", () =>
        HttpResponse.json({
          ...session,
          principal: { ...session.principal, type: "agent" },
          membership: { ...session.membership, role: "member" },
        }),
      ),
    );
    renderApp("/connections");

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "History imports" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Start import" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Advance next range" })).not.toBeInTheDocument();
  });
});
