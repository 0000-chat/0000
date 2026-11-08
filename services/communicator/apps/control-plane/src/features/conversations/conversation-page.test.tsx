import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { apiClient } from "@/lib/api/client";
import { simulatedStore } from "@/mocks/store";
import { server } from "@/mocks/server";
import { pilotScenario } from "@communicator/test-fixtures";

describe("conversation journeys", () => {
  it.each([
    [
      "submitted_to_matrix",
      "Submitted to messaging service — delivery not confirmed",
    ],
    [
      "matrix_confirmed",
      "Messaging service accepted — provider delivery not confirmed",
    ],
    ["delivered", "Delivered — confirmed by provider evidence"],
    [
      "delivery_uncertain",
      "Delivery uncertain — review Activity before any deliberate resend.",
    ],
    [
      "failed",
      "Command saved (failed) — review Activity for its current state.",
    ],
  ])(
    "describes a returned %s command without relabeling it accepted or delivered",
    async (status, message) => {
      server.use(
        http.post("*/api/v1/conversations/:conversationId/messages", () =>
          HttpResponse.json(
            {
              ...pilotScenario.commands[0],
              status,
            },
            { status: 202 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderApp(
        "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
      );
      await user.type(
        await screen.findByRole("textbox", { name: "Message" }),
        "Local status fixture",
      );
      await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(await screen.findByText(message)).toBeVisible();
    },
  );

  it("freezes an ambiguous request and checks the same key and body only on explicit action", async () => {
    const requests: Array<{ key: string | null; body: unknown }> = [];
    server.use(
      http.post(
        "*/api/v1/conversations/:conversationId/messages",
        async ({ request }) => {
          requests.push({
            key: request.headers.get("Idempotency-Key"),
            body: await request.json(),
          });
          return requests.length === 1
            ? HttpResponse.json(
                {
                  error: {
                    code: "service_unavailable",
                    message: "Service unavailable",
                  },
                },
                { status: 502 },
              )
            : HttpResponse.json(
                { ...pilotScenario.commands[0], status: "accepted" },
                { status: 202 },
              );
        },
      ),
    );
    const user = userEvent.setup();
    renderApp(
      "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
    );
    const body = await screen.findByRole("textbox", { name: "Message" });
    await user.type(body, "Keep this exact request");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    const check = await screen.findByRole("button", {
      name: "Retry same request",
    });
    expect(body).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Delivery mode" }),
    ).toBeDisabled();
    expect(screen.getByText(/Acceptance uncertain/)).toBeVisible();
    expect(requests).toHaveLength(1);
    await user.click(check);
    expect(
      await screen.findByText("Accepted — awaiting messaging confirmation"),
    ).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[1]).toEqual(requests[0]);
    expect(body).toBeEnabled();
  });

  it("describes a definitive rejection without clearing the editable draft", async () => {
    server.use(
      http.post("*/api/v1/conversations/:conversationId/messages", () =>
        HttpResponse.json(
          {
            error: { code: "forbidden", message: "Forbidden" },
          },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp(
      "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
    );
    const body = await screen.findByRole("textbox", { name: "Message" });
    await user.type(body, "Keep the rejected draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      await screen.findByText(/Request rejected — no new command accepted/),
    ).toBeVisible();
    expect(body).toBeEnabled();
    expect(body).toHaveValue("Keep the rejected draft");
  });

  it("labels the active thread with identity, provider, and account", async () => {
    renderApp(
      "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram&message=message_conversation_human_telegram_alex_outbound",
    );

    expect(
      await screen.findByRole("heading", { name: "Alex Rivera", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("Human · telegram · Telegram")).toBeVisible();
    expect(screen.getByText("I sent the outline")).toBeVisible();
    expect(
      (
        await screen.findByText("Thanks — noted for the simulated pilot.")
      ).closest("li"),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.queryByRole("link", { name: "Back to conversations" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to conversations" }),
    ).toHaveClass("md:hidden");
    expect(screen.getByTestId("message-viewport")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
    );
    expect(
      screen
        .getByRole("heading", { name: "Alex Rivera", level: 1 })
        .closest("header"),
    ).toHaveClass("sticky", "top-0", "z-[1]");
  });

  it("keeps attention-required history readable and disables sending", async () => {
    await apiClient.resetSimulation("attention_required");
    renderApp(
      "/conversations/conversation_human_messenger_studio?identity=identity_human&channel=connection_human_messenger",
    );

    expect(await screen.findByText("The render is ready")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Delivery mode" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(
      screen.getByText(
        "Sending is unavailable until this connection is repaired.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Manage connection" }),
    ).toHaveAttribute("href", "/connections?identity=identity_human");
  });

  it("shows one generic unavailable state for a cross-channel URL guess", async () => {
    renderApp(
      "/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_telegram",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This conversation is unavailable.",
    );
    expect(screen.queryByText("Family")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to All" })).toBeVisible();
  });

  it("loads older message pages at the top and renders all pages chronologically", async () => {
    const conversationMessages = pilotScenario.messages.filter(
      (message) =>
        message.conversation_id === "conversation_human_whatsapp_family",
    );
    const newest = conversationMessages[1]!;
    const oldest = conversationMessages[0]!;
    server.use(
      http.get(
        "*/api/v1/conversations/:conversationId/messages",
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          return HttpResponse.json(
            cursor === "older-cursor"
              ? { items: [oldest], next_cursor: null }
              : { items: [newest], next_cursor: "older-cursor" },
          );
        },
      ),
    );

    renderApp(
      "/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp",
    );

    const timeline = await screen.findByRole("list", {
      name: "Message timeline",
    });
    expect(timeline).toHaveTextContent(newest.body);
    const loadOlder = screen.getByRole("button", {
      name: "Load older messages",
    });
    expect(loadOlder).toBeVisible();
    const composer = screen.getByRole("form", { name: "Send a message" });

    await userEvent.setup().click(loadOlder);

    const messages = Array.from(timeline.querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(messages[0]).toContain(oldest.body);
    expect(messages[1]).toContain(newest.body);
    expect(
      screen.queryByRole("button", { name: "Load older messages" }),
    ).not.toBeInTheDocument();
    expect(composer).toBeVisible();
  });

  it("fetches an exact saved message outside the initial page", async () => {
    const conversationMessages = pilotScenario.messages.filter(
      (message) =>
        message.conversation_id === "conversation_human_whatsapp_family",
    );
    const newest = conversationMessages[1]!;
    const oldest = conversationMessages[0]!;
    const targetedRequests: string[] = [];
    server.use(
      http.get(
        "*/api/v1/conversations/:conversationId/messages",
        ({ request }) => {
          const search = new URL(request.url).searchParams;
          const messageId = search.get("message_id");
          if (messageId !== null) {
            targetedRequests.push(messageId);
            return HttpResponse.json({ items: [oldest], next_cursor: null });
          }
          return HttpResponse.json({
            items: [newest],
            next_cursor: "older-cursor",
          });
        },
      ),
    );

    renderApp(
      `/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp&message=${oldest.id}`,
    );

    const timeline = await screen.findByRole("list", {
      name: "Message timeline",
    });
    expect(within(timeline).getByText(oldest.body)).toBeVisible();
    expect(
      within(timeline).getByText(oldest.body).closest("li"),
    ).toHaveAttribute("aria-current", "true");
    expect(targetedRequests).toEqual([oldest.id]);
    expect(
      screen.getByRole("button", { name: "Load older messages" }),
    ).toBeVisible();
  });

  it("shows a read denial for an exact saved message", async () => {
    const conversationMessages = pilotScenario.messages.filter(
      (message) =>
        message.conversation_id === "conversation_human_whatsapp_family",
    );
    const oldest = conversationMessages[0]!;
    server.use(
      http.get(
        "*/api/v1/conversations/:conversationId/messages",
        ({ request }) => {
          const search = new URL(request.url).searchParams;
          if (search.has("message_id")) {
            return HttpResponse.json(
              {
                error: {
                  code: "forbidden",
                  message: "Read access denied",
                },
              },
              { status: 403 },
            );
          }
          return HttpResponse.json({ items: [oldest], next_cursor: null });
        },
      ),
    );

    renderApp(
      `/conversations/conversation_human_whatsapp_family?identity=identity_human&channel=connection_human_whatsapp&message=${oldest.id}`,
    );

    expect(
      await screen.findByText(
        "The saved message is unavailable or you do not have read access.",
      ),
    ).toBeVisible();
    const timeline = screen.getByRole("list", { name: "Message timeline" });
    expect(within(timeline).queryByText(oldest.body)).not.toBeInTheDocument();
  });

  it("keeps the inbox and timeline scoped to the selected identity", async () => {
    const user = userEvent.setup();
    renderApp(
      "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
    );

    expect(await screen.findByText("I sent the outline")).toBeVisible();
    await user.selectOptions(
      screen.getByLabelText("Active identity"),
      "identity_agent",
    );

    expect(
      await screen.findByRole("link", { name: /Agent Test Chat/ }),
    ).toBeVisible();
    expect(screen.queryByText("Alex Rivera")).not.toBeInTheDocument();
  });

  it("accepts direct commands but disables unsupported pacing without creating a command", async () => {
    const user = userEvent.setup();
    simulatedStore.reset();
    renderApp(
      "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
    );

    expect(
      await screen.findByRole("heading", { name: "Alex Rivera", level: 1 }),
    ).toBeVisible();
    const composer = screen.getByRole("form", { name: "Send a message" });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Hello from the simulated Human identity",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Delivery mode" }),
      "direct",
    );
    expect(sendButton).toBeEnabled();
    await user.click(sendButton);

    expect(
      await screen.findByText("Accepted — awaiting messaging confirmation"),
    ).toBeVisible();
    expect(simulatedStore.commands("identity_human")).toHaveLength(2);
    expect(composer).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Hello from the simulated Human identity",
    );
    await user.click(sendButton);
    expect(
      await screen.findByText("Accepted — awaiting messaging confirmation"),
    ).toBeVisible();
    expect(simulatedStore.commands("identity_human")).toHaveLength(3);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Delivery mode" }),
      "paced",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "Do not send this paced draft",
    );
    expect(
      screen.queryByText("Accepted — awaiting messaging confirmation"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Human pacing is unavailable")).toBeVisible();
    expect(sendButton).toBeDisabled();
    await user.click(sendButton);
    expect(simulatedStore.commands("identity_human")).toHaveLength(3);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Delivery mode" }),
      "direct",
    );
    expect(sendButton).toBeEnabled();
  });
});
