import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import { pilotScenario } from "@communicator/test-fixtures";
import { renderApp } from "@/test/render-app";
import { runtimeRealtimeClient } from "@/lib/realtime/runtime-client";
import { queryKeys } from "@/lib/api/query-keys";
import type { SimulatedRealtimeClient } from "@/lib/realtime/simulated-client";
import type {
  RealtimeProjectionChangesFrame,
  RealtimeResetRequiredFrame,
  SessionResponse,
} from "@communicator/contracts";

afterEach(() => {
  runtimeRealtimeClient?.close();
  runtimeRealtimeClient?.reset();
  vi.restoreAllMocks();
});

describe("ConversationsShell", () => {
  it("defaults to All and renders every Human conversation in global recency order", async () => {
    renderApp("/conversations?identity=identity_human");

    expect(await screen.findByRole("heading", { name: "Channels" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "All conversations" })).toBeVisible();
    const allButtons = await screen.findAllByRole("button", { name: /All/ });
    expect(allButtons.find((button) => button.getAttribute("aria-current") === "page")).toBeVisible();
    const rows = await screen.findAllByTestId("conversation-row");
    expect(rows.map((row) => row.getAttribute("data-conversation-id"))).toEqual([
      "conversation_human_telegram_alex",
      "conversation_human_whatsapp_family",
      "conversation_human_messenger_studio",
      "conversation_human_whatsapp_alex",
      "conversation_human_telegram_product",
      "conversation_human_messenger_archive",
    ]);
  });

  it("filters the conversation list to the selected channel", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/conversations?identity=identity_human");

    await user.click(await screen.findByRole("button", { name: "Select Telegram" }));
    await waitFor(() => expect(router.state.location.search).toEqual({
      identity: "identity_human",
      channel: "connection_human_telegram",
    }));
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(2);
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("keeps same-name contacts as separate channel-labelled rows in All", async () => {
    renderApp("/conversations?identity=identity_human");
    const alexRows = await screen.findAllByRole("link", { name: /Alex Rivera/ });
    expect(alexRows).toHaveLength(2);
    expect(alexRows[0]).toHaveTextContent(/Telegram|Personal WhatsApp/);
    expect(alexRows[1]).toHaveTextContent(/Telegram|Personal WhatsApp/);
  });

  it("reports an empty channel set with an accessible status", async () => {
    server.use(http.get("*/api/v1/identities/identity_human/channels", () => HttpResponse.json([])));
    renderApp("/conversations?identity=identity_human");
    expect(await screen.findByText("No channels are available for this identity.")).toBeVisible();
  });

  it("reports an empty selected channel without showing unrelated conversations", async () => {
    server.use(http.get("*/api/v1/identities/identity_human/conversations", ({ request }) => {
      if (new URL(request.url).searchParams.get("channel_id") !== "connection_human_telegram") {
        return passthroughResponse();
      }
      return HttpResponse.json({ items: [], next_cursor: null });
    }));
    renderApp("/conversations?identity=identity_human&channel=connection_human_telegram");
    expect(await screen.findByText("No conversations are available for this channel.")).toBeVisible();
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
  });

  it("retries a conversation request after a simulated server error", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(http.get("*/api/v1/identities/identity_human/conversations", ({ request }) => {
      if (new URL(request.url).searchParams.has("channel_id")) return passthroughResponse();
      attempts += 1;
      return attempts === 1
        ? HttpResponse.json({ error: { code: "server_error", message: "Unavailable" } }, { status: 500 })
        : HttpResponse.json({
          items: pilotScenario.conversations.filter((item) => item.identity_id === "identity_human"),
          next_cursor: null,
        });
    }));

    renderApp("/conversations?identity=identity_human");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load conversations");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByTestId("conversation-row")).toHaveLength(6);
  });

  it("keeps loaded conversations and shows bounded retry UI for an older-page failure", async () => {
    const user = userEvent.setup();
    server.use(http.get("*/api/v1/identities/identity_human/conversations", ({ request }) => {
      return new URL(request.url).searchParams.has("cursor")
        ? HttpResponse.json({
          error: { code: "service_unavailable", message: "private conversation detail" },
        }, { status: 503 })
        : HttpResponse.json({
          items: [pilotScenario.conversations[0]!],
          next_cursor: "older-conversation-cursor",
        });
    }));

    renderApp("/conversations?identity=identity_human");
    const rows = await screen.findAllByTestId("conversation-row");
    expect(rows).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Load older conversations" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load older conversations.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private conversation detail");
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(1);
  });

  it("connects once with the authenticated active identity and cleans up on unmount", async () => {
    const connect = vi.spyOn(runtimeRealtimeClient!, "connect");
    const close = vi.spyOn(runtimeRealtimeClient!, "close");
    const { unmount } = renderApp("/conversations?identity=identity_human");

    await screen.findByRole("heading", { name: "All conversations" });
    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      tenantId: "tenant_pilot",
      principalId: "principal_pilot",
      identityIds: ["identity_human"],
      families: ["projection"],
    }));
    expect(connect).toHaveBeenCalledTimes(1);

    unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the old subscription and reconnects after an identity switch", async () => {
    const user = userEvent.setup();
    const connect = vi.spyOn(runtimeRealtimeClient!, "connect");
    const close = vi.spyOn(runtimeRealtimeClient!, "close");
    renderApp("/conversations?identity=identity_human");

    await screen.findByRole("heading", { name: "All conversations" });
    await user.selectOptions(screen.getByLabelText("Active identity"), "identity_agent");
    await screen.findByRole("button", { name: "Select Agent WhatsApp" });

    expect(close).toHaveBeenCalled();
    expect(connect).toHaveBeenLastCalledWith({
      tenantId: "tenant_pilot",
      principalId: "principal_pilot",
      identityIds: ["identity_agent"],
      families: ["projection"],
    });
  });

  it("resets the sequence gate when the principal changes without changing identity", async () => {
    const connect = vi.spyOn(runtimeRealtimeClient!, "connect");
    const { queryClient } = renderApp("/conversations?identity=identity_human");

    await screen.findByRole("heading", { name: "All conversations" });
    await screen.findAllByTestId("conversation-row");
    await waitFor(() => expect(connect).toHaveBeenCalledWith({
      tenantId: "tenant_pilot",
      principalId: "principal_pilot",
      identityIds: ["identity_human"],
      families: ["projection"],
    }));

    const simulatedClient = runtimeRealtimeClient as SimulatedRealtimeClient;
    const familyRow = () => screen.getAllByTestId("conversation-row").find(
      (row) => row.getAttribute("data-conversation-id") === "conversation_human_whatsapp_family",
    )!;
    const publishMessage = (lastMessagePreview: string) => simulatedClient.publishMessage({
      tenantId: "tenant_pilot",
      identityId: "identity_human",
      connectionId: "connection_human_whatsapp",
      conversationId: "conversation_human_whatsapp_family",
      lastMessagePreview,
      lastActivityAt: "2026-09-11T00:00:00.000Z",
      unreadDelta: 0,
    });

    queryClient.setQueryData(queryKeys.channels("identity_agent"), ["agent cache"]);
    publishMessage("High sequence update");
    publishMessage("Higher sequence update");
    expect(simulatedClient.lastSequence).toBe(2);
    await waitFor(() => expect(familyRow()).toHaveTextContent("Higher sequence update"));

    const session = queryClient.getQueryData<SessionResponse>(queryKeys.session);
    expect(session).toBeDefined();
    queryClient.setQueryData<SessionResponse>(queryKeys.session, {
      ...session!,
      principal: {
        ...session!.principal,
        id: "principal_reconnected",
        display_name: "Reconnected operator",
      },
    });

    await waitFor(() => expect(connect).toHaveBeenLastCalledWith({
      tenantId: "tenant_pilot",
      principalId: "principal_reconnected",
      identityIds: ["identity_human"],
      families: ["projection"],
    }));
    expect(connect).toHaveBeenCalledTimes(2);

    simulatedClient.reset();
    publishMessage("Lower sequence after reconnect");

    await waitFor(() => expect(familyRow()).toHaveTextContent("Lower sequence after reconnect"));
    expect(queryClient.getQueryData(queryKeys.channels("identity_agent"))).toEqual(["agent cache"]);
  });

  it("does not connect when the authenticated session has no identity", async () => {
    server.use(http.get("*/api/v1/session", () => HttpResponse.json({
      tenant: { id: "tenant_pilot", slug: "pilot", display_name: "Pilot tenant" },
      principal: { id: "principal_pilot", type: "operator", display_name: "Pilot operator" },
      membership: { id: "membership_pilot", role: "admin" },
      identities: [],
    })));
    const connect = vi.spyOn(runtimeRealtimeClient!, "connect");

    renderApp("/conversations");

    expect(await screen.findByText("Loading identity…")).toBeVisible();
    await waitFor(() => expect(connect).not.toHaveBeenCalled());
  });

  it("invalidates only the active identity for a projection change", async () => {
    const subscribe = vi.spyOn(runtimeRealtimeClient!, "subscribe");
    const { queryClient } = renderApp("/conversations?identity=identity_human");
    await screen.findByRole("heading", { name: "All conversations" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    queryClient.setQueryData(queryKeys.channels("identity_agent"), ["agent cache"]);

    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    const listener = subscribe.mock.calls.at(-1)?.[0] as (event: unknown) => void;
    const frame: RealtimeProjectionChangesFrame = {
      schema_version: 1,
      type: "projection.changes",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      generation: 1,
      from_sequence: 1,
      to_sequence: 2,
      changes: [{
        sequence: 1,
        event_type: "message.created",
        connection_id: "connection_human_telegram",
        conversation_id: "conversation_human_telegram_alex",
        occurred_at: "2026-08-28T00:07:00.000Z",
      }],
    };
    listener(frame);

    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["channels", "identity_human"],
      ["conversations", "identity_human", "all"],
      ["conversations", "identity_human", "connection_human_telegram"],
      ["conversation", "identity_human", "conversation_human_telegram_alex"],
      ["messages", "identity_human", "conversation_human_telegram_alex"],
    ]);
    expect(invalidate.mock.calls.every(([filters]) => !filters?.queryKey?.includes("identity_agent"))).toBe(true);
    expect(queryClient.getQueryData(queryKeys.channels("identity_agent"))).toEqual(["agent cache"]);
  });

  it("invalidates bounded identity prefixes for missing IDs and reset frames", async () => {
    const subscribe = vi.spyOn(runtimeRealtimeClient!, "subscribe");
    const { queryClient } = renderApp("/conversations?identity=identity_human");
    await screen.findByRole("heading", { name: "All conversations" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    const listener = subscribe.mock.calls.at(-1)?.[0] as (event: unknown) => void;

    listener({
      sequence: 1,
      type: "message.created",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      occurred_at: "2026-08-28T00:07:00.000Z",
      data: {},
    });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["channels", "identity_human"],
      ["conversations", "identity_human"],
      ["conversation", "identity_human"],
      ["messages", "identity_human"],
    ]);

    invalidate.mockClear();
    const reset: RealtimeResetRequiredFrame = {
      schema_version: 1,
      type: "reset_required",
      tenant_id: "tenant_pilot",
      identity_id: "identity_human",
      generation: 2,
      latest_sequence: 4,
      reason: "history_unavailable",
    };
    listener(reset);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]?.[0]).toEqual({
      predicate: expect.any(Function),
    });
  });
});

function passthroughResponse() {
  return HttpResponse.json({ items: [], next_cursor: null });
}
