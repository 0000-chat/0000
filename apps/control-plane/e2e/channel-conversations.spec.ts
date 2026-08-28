import { expect, test } from "@playwright/test";

const localOrigin = "http://127.0.0.1:4173";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("SIMULATED DATA");
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "ready" }),
    });
    return response.status;
  });
  expect(status).toBe(200);
});

test("All and channel views preserve recency, labels, and separate contacts", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const rows = page.getByTestId("conversation-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText("Alex Rivera");
  await expect(rows.nth(0)).toContainText("Telegram");
  await expect(page.getByRole("link", { name: /Alex Rivera/ })).toHaveCount(2);

  await page.getByRole("button", { name: /Select Telegram/ }).click();
  await expect(page).toHaveURL(/channel=connection_human_telegram/);
  await expect(rows).toHaveCount(2);
});

test("identity and channel URL guesses fail symmetrically", async ({ page }) => {
  await page.goto("/conversations/conversation_agent_one?identity=identity_human&channel=connection_human_whatsapp");
  await expect(page.getByRole("alert")).toContainText("This conversation is unavailable.");
  await expect(page.getByText(/Agent WhatsApp/)).toHaveCount(0);

  await page.goto("/conversations/conversation_human_whatsapp_family?identity=identity_agent&channel=connection_agent_whatsapp");
  await expect(page.getByRole("alert")).toContainText("This conversation is unavailable.");
  await expect(page.getByText(/Personal WhatsApp/)).toHaveCount(0);
});

test("message activity updates All without moving channel navigation", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const channelNavigation = page.getByRole("navigation", { name: "Conversation channels" }).filter({ visible: true });
  await expect(channelNavigation.getByRole("button", { name: /All.*10/ })).toBeVisible();
  await expect(channelNavigation.locator('[data-channel-id="connection_human_whatsapp"]').getByRole("button").first()).toContainText("Personal WhatsApp");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_whatsapp"]').getByRole("button").first()).toContainText("5");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_telegram"]').getByRole("button").first()).toContainText("Telegram");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_telegram"]').getByRole("button").first()).toContainText("3");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_messenger"]').getByRole("button").first()).toContainText("Messenger");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_messenger"]').getByRole("button").first()).toContainText("2");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/realtime/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenant_id: "tenant_pilot",
        identity_id: "identity_human",
        connection_id: "connection_human_messenger",
        conversation_id: "conversation_human_messenger_archive",
        last_message_preview: "Newest simulated event",
        last_activity_at: "2026-08-28T00:08:00.000Z",
        unread_delta: 1,
      }),
    });
    return response.status;
  });
  expect(status).toBe(200);

  await expect(page.getByTestId("conversation-row").first()).toContainText("Old Client");
  await expect(channelNavigation.getByRole("button", { name: /All.*11/ })).toBeVisible();
  await expect(channelNavigation.locator('[data-channel-id="connection_human_messenger"]').getByRole("button").first()).toContainText("Messenger");
  await expect(channelNavigation.locator('[data-channel-id="connection_human_messenger"]').getByRole("button").first()).toContainText("3");
  const labels = await channelNavigation.locator("[data-channel-id]").evaluateAll(
    (rows) => rows.map((row) => row.getAttribute("data-channel-id")),
  );
  expect(labels).toEqual([
    "connection_human_whatsapp",
    "connection_human_telegram",
    "connection_human_messenger",
  ]);
});

test("manual channel order survives ordinary navigation", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const reorderTelegram = page.getByRole("button", { name: "Reorder Telegram" });
  await reorderTelegram.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect(page.locator("[data-channel-id]").first()).toHaveAttribute(
    "data-channel-id",
    "connection_human_telegram",
  );

  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity\?identity=identity_human/);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page).toHaveURL(/\/conversations\?identity=identity_human/);
  const labels = await page.getByRole("navigation", { name: "Conversation channels" }).filter({ visible: true }).locator("[data-channel-id]").evaluateAll(
    (rows) => rows.map((row) => row.getAttribute("data-channel-id")),
  );
  expect(labels).toEqual([
    "connection_human_telegram",
    "connection_human_whatsapp",
    "connection_human_messenger",
  ]);
  await expect(page.getByRole("button", { name: /Move .* (up|down)/ })).toHaveCount(0);
});

test("identity switch replaces every scoped surface", async ({ page }) => {
  await page.goto("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
  await expect(page.getByRole("heading", { name: "Alex Rivera", level: 1 })).toBeVisible();
  await page.getByLabel("Active identity").selectOption("identity_agent");
  await expect(page).toHaveURL(/\/conversations\?identity=identity_agent$/);
  await expect(page.getByRole("button", { name: "Select Agent WhatsApp" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Agent Test Chat/ })).toBeVisible();
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Telegram", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Messenger", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Alex Rivera", { exact: true })).toHaveCount(0);
});

test("direct and paced sends stay on the opened connection", async ({ page }) => {
  await page.goto("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
  const message = page.getByRole("textbox", { name: "Message" });
  const mode = page.getByRole("combobox", { name: "Delivery mode" });
  const send = page.getByRole("button", { name: "Send message" });

  await message.fill("A simulated direct message");
  await mode.selectOption("direct");
  const directResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/conversations/conversation_human_telegram_alex/messages")
    && response.request().method() === "POST"
    && response.status() === 202,
  );
  await send.click();
  await directResponse;
  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();

  await message.fill("A simulated paced message");
  await mode.selectOption("paced");
  const pacedResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v1/conversations/conversation_human_telegram_alex/messages")
    && response.request().method() === "POST"
    && response.status() === 202,
  );
  await send.click();
  await pacedResponse;
  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();

  const commands = await page.evaluate(async () => {
    const [commandsResponse, conversationResponse] = await Promise.all([
      fetch("/api/v1/commands?identity_id=identity_human"),
      fetch("/api/v1/identities/identity_human/conversations/conversation_human_telegram_alex"),
    ]);
    const commands = await commandsResponse.json() as Array<{ conversation_id: string; delivery_mode: string }>;
    const conversation = await conversationResponse.json() as { connection_id: string };
    return {
      sent: commands.filter((command) => command.conversation_id === "conversation_human_telegram_alex"),
      connectionId: conversation.connection_id,
    };
  });
  expect(commands.connectionId).toBe("connection_human_telegram");
  expect(commands.sent.map((command) => command.delivery_mode)).toEqual(["direct", "paced"]);
});

test("attention history remains readable but unsendable", async ({ page }) => {
  await page.goto("/connections?identity=identity_human");
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toBeVisible();
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "attention_required" }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: /Select Messenger/ }).click();
  await page.getByRole("link", { name: /Studio Team/ }).click();
  await expect(page.getByRole("list", { name: "Message timeline" }).getByText("The render is ready")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Delivery mode" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Manage connection" })).toHaveAttribute(
    "href",
    "/connections?identity=identity_human",
  );
});

test("mobile channel selection and back navigation work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/conversations?identity=identity_human");
  await page.getByRole("button", { name: "Channel: All" }).click();
  const dialog = page.getByRole("dialog", { name: "Channels" });
  await dialog.getByRole("button", { name: "Select Telegram" }).click();
  await expect(page).toHaveURL(/channel=connection_human_telegram/);
  await expect(page.getByRole("button", { name: "Channel: Telegram" })).toBeVisible();
  await page.getByTestId("conversation-row").first().click();
  await expect(page.getByRole("heading", { name: "Alex Rivera", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Back to conversations" }).click();
  await expect(page).toHaveURL(/\/conversations\?identity=identity_human&channel=connection_human_telegram/);
  await expect(page.getByTestId("conversation-row")).toHaveCount(2);
});

test("tablet and desktop expose the intended panes", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/conversations?identity=identity_human");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).first()).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Conversation channels" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversation inbox" })).toBeVisible();
  await expect(page.getByText("Select a conversation to view its messages.")).toBeVisible();

  await expect(page.getByTestId("conversation-workspace")).toHaveClass(/overflow-hidden/);
  await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All conversations" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Primary navigation" }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Conversation channels" }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversation inbox" })).toBeVisible();
  await expect(page.getByText("Select a conversation to view its messages.")).toBeVisible();
  await expect(page.getByTestId("conversation-workspace")).toHaveClass(/overflow-hidden/);
  await expect(page.getByTestId("conversation-workspace")).not.toHaveClass(/rounded/);
});

test("desktop messenger regions scroll independently and keep the thread composer anchored", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
  await expect(page.getByTestId("message-viewport")).toBeVisible();

  const scrollRegions = page.locator("[data-testid='conversation-workspace'] .overflow-y-auto");
  await expect(scrollRegions).toHaveCount(3);
  const overflowValues = await scrollRegions.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).overflowY));
  expect(overflowValues).toEqual(["auto", "auto", "auto"]);
  await expect(page.getByTestId("message-viewport")).toHaveCSS("overflow-y", "auto");
  await expect(page.getByTestId("message-viewport").getByRole("form", { name: "Send a message" })).toHaveCount(0);

  const composer = page.getByRole("form", { name: "Send a message" });
  const initialComposerBox = await composer.boundingBox();
  await page.getByTestId("message-viewport").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const finalComposerBox = await composer.boundingBox();
  expect(finalComposerBox?.y).toBe(initialComposerBox?.y);
});

test("production plus simulation fails closed", async () => {
  const { execFileSync } = await import("node:child_process");
  expect(() => execFileSync("pnpm", ["vite", "build"], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_DEPLOYMENT_ENV: "production", VITE_DATA_MODE: "simulated" },
    stdio: "ignore",
  })).toThrow();
});

test("simulated browser never contacts a live service", async ({ page }) => {
  const requests: string[] = [];
  const localOrigin = new URL(page.url()).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (url.origin !== localOrigin || (request.resourceType() === "fetch" && !path.startsWith("/api/v1/"))) {
      requests.push(`${request.method()} ${url.origin}${path}`);
    }
  });

  await page.goto("/conversations?identity=identity_human");
  await page.getByRole("button", { name: /Select Telegram/ }).click();
  await page.getByTestId("conversation-row").first().click();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("A local simulated message");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();
  expect(requests).toEqual([]);
});
