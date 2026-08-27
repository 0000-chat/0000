import { expect, test } from "@playwright/test";

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

test("accepts one direct command when the send is retried by the browser", async ({ page }) => {
  await page.goto("/conversations/conversation_human_one");
  await page.getByRole("textbox", { name: "Message" }).fill("Hello from the simulated Human identity");
  await page.getByRole("combobox", { name: "Delivery mode" }).selectOption("direct");
  await page.getByRole("button", { name: "Send message" }).dblclick();

  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();
  await page.getByRole("link", { name: "Activity", exact: true }).first().click();
  await expect(page.getByRole("list", { name: "Command activity" }).getByRole("listitem")).toHaveCount(2);
});

test("previews paced delivery and records its accepted command phase", async ({ page }) => {
  await page.goto("/conversations/conversation_human_one");
  await page.getByRole("textbox", { name: "Message" }).fill("Hello from the simulated Human identity");
  await page.getByRole("combobox", { name: "Delivery mode" }).selectOption("paced");

  for (const phase of [
    "Mark read (when supported)",
    "Reading delay",
    "Typing indicator",
    "Send message",
  ]) {
    await expect(page.getByText(phase, { exact: true }).first()).toBeVisible();
  }
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();

  await page.getByRole("link", { name: "Activity", exact: true }).first().click();
  await expect(page.getByText("Human-paced", { exact: true })).toBeVisible();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
});

test("shows the attention-required scenario and can reset it from System", async ({ page }) => {
  await page.goto("/connections");
  await expect(page.getByRole("status").filter({ hasText: "SIMULATED DATA" })).toBeVisible();
  const attention = await page.evaluate(async () => {
    const response = await fetch("/api/v1/testing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "attention_required" }),
    });
    return response.status;
  });
  expect(attention).toBe(200);

  const identitySwitcher = page.getByRole("combobox", { name: "Active identity" });
  await identitySwitcher.selectOption("identity_agent");
  await expect(page.getByText("Agent WhatsApp", { exact: true })).toBeVisible();
  await identitySwitcher.selectOption("identity_human");
  await expect(page.getByRole("alert")).toContainText("Action required");
  await expect(page.getByRole("button", { name: /Simulation only.*Reconnect/ })).toBeDisabled();

  await page.goto("/system");
  await page.getByRole("button", { name: "Reset simulated scenario" }).click();
  await expect(page.getByRole("status", { name: "Simulation reset complete" })).toBeVisible();
});
