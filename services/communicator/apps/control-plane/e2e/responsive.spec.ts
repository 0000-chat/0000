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

test("keeps desktop navigation visible and provides mobile navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/conversations?identity=identity_human");
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).first(),
  ).toBeHidden();
  await expect(
    page
      .getByRole("navigation", { name: "Conversation channels" })
      .filter({ visible: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("link", { name: "Connections", exact: true }),
  ).toBeVisible();
});
