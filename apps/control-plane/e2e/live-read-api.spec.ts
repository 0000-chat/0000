import { expect, test } from "@playwright/test";

const humanConversation = "conversation_human_telegram_alex";
const agentConversation = "conversation_agent_one";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("SIMULATED DATA");
  const resetStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "ready" }),
    });
    return response.status;
  });
  expect(resetStatus).toBe(200);
});

test("keeps Human and Agent inboxes isolated and denies a direct cross-identity route", async ({ page }) => {
  await page.goto(`/conversations/${humanConversation}?identity=identity_human&channel=connection_human_telegram`);
  await expect(page.getByRole("heading", { name: "Alex Rivera", level: 1 })).toBeVisible();
  await expect(page.getByTestId("message-viewport").getByText("I sent the outline")).toBeVisible();

  await page.getByLabel("Active identity").selectOption("identity_agent");
  await expect(page).toHaveURL(/\/conversations\?identity=identity_agent$/);
  await expect(page.getByRole("link", { name: /Agent Test Chat/ })).toBeVisible();
  await expect(page.getByText("Alex Rivera", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toHaveCount(0);

  await page.goto(`/conversations/${humanConversation}?identity=identity_agent&channel=connection_agent_whatsapp`);
  await expect(page.getByRole("alert")).toContainText("This conversation is unavailable.");
  await expect(page.getByText("Family", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toHaveCount(0);
});

test("filters channels without changing the conversation recency order", async ({ page }) => {
  await page.goto("/conversations?identity=identity_human");
  const rows = page.getByTestId("conversation-row");
  await expect(rows).toHaveCount(6);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-conversation-id")))).toEqual([
    "conversation_human_telegram_alex",
    "conversation_human_whatsapp_family",
    "conversation_human_messenger_studio",
    "conversation_human_whatsapp_alex",
    "conversation_human_telegram_product",
    "conversation_human_messenger_archive",
  ]);

  await page.getByRole("button", { name: "Select Telegram" }).click();
  await expect(page).toHaveURL(/channel=connection_human_telegram/);
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-conversation-id")))).toEqual([
    "conversation_human_telegram_alex",
    "conversation_human_telegram_product",
  ]);
});

test("prepends older messages chronologically while keeping the composer fixed", async ({ page }) => {
  const resetStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "ready", message_mode: "pages" }),
    });
    return response.status;
  });
  expect(resetStatus).toBe(200);

  await page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Conversations", exact: true })
    .click();
  const identitySwitcher = page.getByLabel("Active identity");
  await expect(identitySwitcher).toBeEnabled();
  await identitySwitcher.selectOption("identity_agent");
  await expect(identitySwitcher).toHaveValue("identity_agent");
  const agentConversationLink = page.getByRole("link", { name: /Agent Test Chat/ });
  await expect(agentConversationLink).toBeVisible();
  await agentConversationLink.click();
  const timeline = page.getByRole("list", { name: "Message timeline" });
  await expect(timeline).toContainText("This fixture contains no live provider data.");
  const loadOlder = page.getByRole("button", { name: "Load older messages" });
  await expect(loadOlder).toBeVisible();
  const composer = page.getByRole("form", { name: "Send a message" });
  const initialComposerBox = await composer.boundingBox();

  await loadOlder.click();
  await expect(timeline).toContainText("A simulated Agent conversation is available.");
  await expect(timeline.locator("li").first()).toContainText("A simulated Agent conversation is available.");
  await expect(timeline.locator("li").last()).toContainText("This fixture contains no live provider data.");
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
  const finalComposerBox = await composer.boundingBox();
  expect(finalComposerBox?.y).toBe(initialComposerBox?.y);
});

test("shows bounded retry UI for a failed message read without rendering the payload", async ({ page }) => {
  const resetStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "ready", message_mode: "error" }),
    });
    return response.status;
  });
  expect(resetStatus).toBe(200);

  await page.getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Conversations", exact: true })
    .click();
  await page.locator(`[data-testid="conversation-row"][data-conversation-id="${humanConversation}"]`).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Unable to load messages.");
  await expect(alert).not.toContainText("private backend detail");
  await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
});
