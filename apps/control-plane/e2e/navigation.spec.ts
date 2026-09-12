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

test("navigates to all primary screens", async ({ page }) => {
  await page.goto("/");
  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });

  for (const screen of ["Overview", "Connections", "Conversations", "Activity", "System"]) {
    await primaryNavigation.getByRole("link", { name: screen, exact: true }).click();
    await expect(page.getByRole("heading", { name: screen, exact: true })).toBeVisible();
    if (screen === "Conversations") {
      await expect(page.getByRole("navigation", { name: "Conversation channels" }).filter({ visible: true })).toBeVisible();
    }
  }
});
