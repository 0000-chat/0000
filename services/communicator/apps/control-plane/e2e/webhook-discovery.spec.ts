import { expect, test } from "@playwright/test";

test("discovers independent subscriptions, selects by keyboard and explicitly retries only the chosen webhook", async ({
  page,
}) => {
  await page.goto("/system");
  await expect(page.getByRole("status").first()).toContainText(
    "SIMULATED DATA",
  );
  const audit = page.getByRole("article", {
    name: "Subscription subscription_audit",
  });
  const auditDelivery = audit.getByRole("button", {
    name: /delivery_audit · uncertain/,
  });
  await expect(auditDelivery).toBeVisible();
  await auditDelivery.focus();
  await page.keyboard.press("Enter");
  const auditDetails = audit.getByLabel("Webhook delivery details");
  await expect(auditDetails).toContainText("delivery_audit · uncertain");
  const deadlineValue = auditDetails
    .getByText("Automatic retry deadline (24 hours)", { exact: true })
    .locator("..")
    .locator("dd");
  const deadline = await deadlineValue.textContent();
  await page.getByRole("button", { name: "Load more subscriptions" }).click();
  const support = page.getByRole("article", {
    name: "Subscription subscription_support",
  });
  await support
    .getByRole("button", { name: /delivery_support · failed/ })
    .click();
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  await expect(auditDelivery).toHaveAttribute("aria-pressed", "true");
  await audit.getByRole("button", { name: "Load more deliveries" }).click();
  const delivered = audit.getByRole("button", {
    name: /delivery_audit_z · delivered/,
  });
  await delivered.click();
  await expect(auditDetails).toContainText("delivery_audit_z · delivered");
  await expect(delivered).toHaveAttribute("aria-pressed", "true");
  await expect(
    audit.getByRole("button", { name: "Retry webhook delivery" }),
  ).toHaveCount(0);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(auditDetails).toContainText("delivery_audit · uncertain");
  await expect(delivered).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(auditDetails).toContainText("delivery_audit_z · delivered");
  await expect(delivered).toHaveAttribute("aria-pressed", "true");
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  await auditDelivery.click();
  await expect(auditDetails).toContainText("delivery_audit · uncertain");
  page.once("dialog", (dialog) => dialog.dismiss());
  await audit.getByRole("button", { name: "Retry webhook delivery" }).click();
  await expect(auditDetails).toContainText("delivery_audit · uncertain");
  page.once("dialog", (dialog) => dialog.accept());
  await audit.getByRole("button", { name: "Retry webhook delivery" }).click();
  await expect(auditDetails).toContainText("delivery_audit · pending");
  await expect(auditDetails).toContainText("not a delivery receipt");
  await expect(deadlineValue).toHaveText(deadline ?? "missing deadline");
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  await audit.getByRole("button", { name: "Refresh deliveries" }).click();
  await expect(audit.getByLabel("Webhook delivery details")).toHaveCount(0);
  await expect(
    audit.getByRole("button", { name: /delivery_audit · pending/ }),
  ).toBeVisible();
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  await expect(page.getByLabel("Delivery ID")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const retrySupport = support.getByRole("button", {
    name: "Retry webhook delivery",
  });
  await retrySupport.scrollIntoViewIfNeeded();
  await expect(retrySupport).toBeInViewport();
  await expect(retrySupport).toBeEnabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await retrySupport.click();
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
});
