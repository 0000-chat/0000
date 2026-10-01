import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { server } from "@/mocks/server";
import { simulatedStore } from "@/mocks/store";
import { queryKeys } from "@/lib/api/query-keys";
import { apiClient } from "@/lib/api/client";

describe("IdentitySwitcher", () => {
  it("switches a thread to the new identity All inbox", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(
      "/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp",
    );

    await screen.findByRole("option", { name: "Agent" });
    await user.selectOptions(
      await screen.findByLabelText("Active identity"),
      "identity_agent",
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/conversations");
      expect(router.state.location.search).toEqual({
        identity: "identity_agent",
      });
    });
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("uses one session response for authorized identities and channel order storage", async () => {
    let sessionRequests = 0;
    server.use(
      http.get("*/api/v1/session", () => {
        sessionRequests += 1;
        return HttpResponse.json(simulatedStore.session());
      }),
      http.get("*/api/v1/me", () => {
        throw new Error("the identity provider must not request /me");
      }),
      http.get("*/api/v1/identities", () => {
        throw new Error("the identity provider must not request /identities");
      }),
    );
    sessionStorage.setItem(
      "communicator:channel-order:principal_pilot:identity_human",
      JSON.stringify([
        "connection_human_messenger",
        "connection_human_whatsapp",
        "connection_human_telegram",
      ]),
    );

    renderApp("/conversations?identity=identity_human");

    await screen.findByRole("option", { name: "Agent" });
    expect(sessionRequests).toBe(1);
    const channelNavigation = await screen.findByRole("navigation", {
      name: "Conversation channels",
    });
    const channelRows = Array.from(
      channelNavigation.querySelectorAll("[data-channel-id]"),
    );
    expect(
      channelRows.map((row) => row.getAttribute("data-channel-id")),
    ).toEqual([
      "connection_human_messenger",
      "connection_human_whatsapp",
      "connection_human_telegram",
    ]);
  });

  it("removes the previous identity's scoped query caches before switching", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderApp("/conversations?identity=identity_human");

    await screen.findByText("I sent the outline");
    queryClient.setQueryData(
      queryKeys.messages("identity_human", "conversation_human_telegram_alex"),
      {
        pages: [],
        pageParams: [],
      },
    );

    await user.selectOptions(
      await screen.findByLabelText("Active identity"),
      "identity_agent",
    );

    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          queryKeys.messages(
            "identity_human",
            "conversation_human_telegram_alex",
          ),
        ),
      ).toBeUndefined();
    });
  });

  it("clears a background auth pause after an identical successful session read", async () => {
    const { queryClient } = renderApp("/");
    await screen.findByRole("option", { name: "Agent" });

    server.use(
      http.get("*/api/v1/identities/identity_human/channels", () =>
        HttpResponse.json(
          {
            error: {
              code: "unauthenticated",
              message: "Session expired",
            },
          },
          { status: 401 },
        ),
      ),
    );
    await expect(apiClient.getChannels("identity_human")).rejects.toMatchObject(
      { status: 401 },
    );
    expect(
      await screen.findByText(
        "Sign in to read and change protected Communicator data.",
      ),
    ).toBeVisible();

    await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Sign in to read and change protected Communicator data.",
        ),
      ).not.toBeInTheDocument();
    });
  });
});
