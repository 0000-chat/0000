import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";

describe("IdentitySwitcher", () => {
  it("switches a thread to the new identity All inbox", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(
      "/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp",
    );

    await screen.findByRole("option", { name: "Agent" });
    await user.selectOptions(await screen.findByLabelText("Active identity"), "identity_agent");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/conversations");
      expect(router.state.location.search).toEqual({ identity: "identity_agent" });
    });
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });
});
