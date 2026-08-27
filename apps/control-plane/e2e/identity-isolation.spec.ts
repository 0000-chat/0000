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

test("switches identities symmetrically in Connections and Conversations", async ({ page }) => {
  await page.goto("/connections");
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent WhatsApp", { exact: true })).toHaveCount(0);
  await page.getByLabel("Active identity").selectOption("identity_agent");
  await expect(page.getByText("Agent WhatsApp", { exact: true })).toBeVisible();
  await expect(page.getByText("Personal WhatsApp", { exact: true })).toHaveCount(0);

  await page.goto("/conversations");
  await expect(page.getByRole("link", { name: /Example Contact/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Agent Test Chat/ })).toHaveCount(0);
  await page.getByLabel("Active identity").selectOption("identity_agent");
  await expect(page.getByRole("link", { name: /Agent Test Chat/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Example Contact/ })).toHaveCount(0);
});
