import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { simulatedStore } from "@/mocks/store";

function enabledLinkButton() {
  return screen
    .getAllByRole("button", { name: "Link WhatsApp account" })
    .find((button) => !(button as HTMLButtonElement).disabled);
}

async function openLinkSheet() {
  const user = userEvent.setup();
  const button = enabledLinkButton();
  expect(button).toBeDefined();
  await user.click(button!);
  expect(
    await screen.findByRole("heading", { name: "Link WhatsApp account" }),
  ).toBeVisible();
  return user;
}

describe("WhatsApp linking", () => {
  it("shows an ephemeral QR to an authorized administrator and completes without an agent grant", async () => {
    renderApp("/connections?identity=identity_human");
    expect(await screen.findByText("Personal WhatsApp")).toBeVisible();

    await openLinkSheet();

    const qr = await screen.findByAltText(
      "WhatsApp QR code to scan from Linked devices",
    );
    expect(qr).toHaveAttribute("src", expect.stringContaining("data:image/"));
    expect(screen.getByText("Pilot operator")).toBeVisible();
    expect(screen.getByText("Target identity")).toBeVisible();
    expect(screen.getByText("Waiting for QR scan")).toBeVisible();

    expect(await screen.findByText("WhatsApp account linked")).toBeVisible();
    expect(screen.getByText(/No agent access was granted\./)).toBeVisible();
    expect(simulatedStore.accountGrants()).toHaveLength(0);
  });

  it("clears the QR and cancels the provider attempt when the administrator cancels", async () => {
    renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    const user = await openLinkSheet();
    await screen.findByAltText("WhatsApp QR code to scan from Linked devices");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(simulatedStore.linkSession("link_sim_1")).toMatchObject({
        status: "cancelled",
        qr: null,
      });
      expect(
        screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
      ).not.toBeInTheDocument();
    });
  });

  it("refreshes the challenge with a new generation", async () => {
    renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    const user = await openLinkSheet();
    const firstQr = await screen.findByAltText(
      "WhatsApp QR code to scan from Linked devices",
    );
    const firstSource = firstQr.getAttribute("src");

    await user.click(screen.getByRole("button", { name: "Refresh QR" }));

    const refreshedQr = await screen.findByAltText(
      "WhatsApp QR code to scan from Linked devices",
    );
    expect(refreshedQr.getAttribute("src")).not.toBe(firstSource);
    expect(simulatedStore.linkSession("link_sim_1")).toMatchObject({
      generation: 2,
      status: "awaiting_user",
    });
  });

  it("cancels and removes the challenge when the dialog unmounts", async () => {
    const rendered = renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    await openLinkSheet();
    await screen.findByAltText("WhatsApp QR code to scan from Linked devices");

    rendered.unmount();

    await waitFor(() => {
      expect(simulatedStore.linkSession("link_sim_1")).toMatchObject({
        status: "cancelled",
        qr: null,
      });
      expect(
        screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
      ).not.toBeInTheDocument();
    });
  });

  it("removes the QR on provider expiry and offers a fresh attempt", async () => {
    simulatedStore.setLinkScenario("expired");
    renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    await openLinkSheet();
    await screen.findByAltText("WhatsApp QR code to scan from Linked devices");

    expect(await screen.findByText("QR session expired")).toBeVisible();
    expect(
      screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("hides the QR when expiry wins a delayed provider poll", async () => {
    simulatedStore.setLinkActionDelay(1_500);
    simulatedStore.setLinkActionExpiry(1_200);
    renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    await openLinkSheet();
    await screen.findByAltText("WhatsApp QR code to scan from Linked devices");

    expect(await screen.findByText("QR session expired")).toBeVisible();
    expect(
      screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("WhatsApp account linked"),
    ).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(simulatedStore.linkSession("link_sim_1")).toMatchObject({
      status: "cancelled",
      qr: null,
    });
  });

  it("offers retry after a provider error and handles duplicate identity safely", async () => {
    simulatedStore.setLinkScenario("provider_error");
    renderApp("/connections?identity=identity_human");
    await screen.findByText("Personal WhatsApp");
    const user = await openLinkSheet();
    expect(await screen.findByText("WhatsApp linking failed")).toBeVisible();
    expect(
      screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
    ).not.toBeInTheDocument();

    simulatedStore.setLinkScenario("connected");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByAltText(
        "WhatsApp QR code to scan from Linked devices",
      ),
    ).toBeVisible();
    expect(await screen.findByText("WhatsApp account linked")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Close linking dialog" }),
    );
    simulatedStore.setLinkScenario("duplicate");
    await user.click(enabledLinkButton()!);
    expect(await screen.findByText("Relinking required")).toBeVisible();
    expect(
      screen.queryByAltText("WhatsApp QR code to scan from Linked devices"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("does not expose a linking action for an agent identity", async () => {
    renderApp("/connections?identity=identity_agent");
    expect(await screen.findByText("Agent WhatsApp")).toBeVisible();
    expect(
      screen
        .getAllByRole("button", { name: "Link WhatsApp account" })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });
});
