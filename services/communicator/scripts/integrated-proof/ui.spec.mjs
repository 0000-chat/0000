import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../apps/control-plane/package.json", import.meta.url),
);
const { test, expect } = require("@playwright/test");

// Deliberately separate from run.mjs. MSW exercises essential presentation and
// interactions, not the real backend or a live provider/client acceptance.
test("essential simulated states preserve uncertain send and independent webhook decisions", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  if (process.env.COMMUNICATOR_PROOF_RECORD)
    await page.addInitScript(() => {
      window.addEventListener("DOMContentLoaded", () => {
        const cursor = document.createElement("div");
        cursor.style.cssText =
          "position:fixed;width:16px;height:16px;border:2px solid #ef4444;border-radius:50%;background:#ef444440;pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%)";
        document.body.appendChild(cursor);
        document.addEventListener("pointermove", (event) => {
          cursor.style.left = `${event.clientX}px`;
          cursor.style.top = `${event.clientY}px`;
        });
      });
    });
  const click = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    if (process.env.COMMUNICATOR_PROOF_RECORD) {
      // Traverse a neighboring control area visibly before the target click.
      for (let step = 0; step <= 8; step++) {
        await page.mouse.move(
          Math.max(1, bounds.x - 80) + ((bounds.width / 2 + 80) * step) / 8,
          bounds.y + bounds.height / 2,
        );
        await page.waitForTimeout(70);
      }
    }
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      { steps: 24 },
    );
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
  };
  await page.goto("/");
  await expect(page.getByRole("status").first()).toContainText(
    "SIMULATED DATA",
  );
  const reset = await page.evaluate(
    async () =>
      (
        await fetch("/api/v1/testing/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenario: "ready" }),
        })
      ).status,
  );
  expect(reset).toBe(200);
  await page.goto(
    "/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram",
  );
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("conversation-ready.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    let lose = true;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await original(request);
      if (
        lose &&
        request.method === "POST" &&
        request.url.includes("/messages")
      ) {
        lose = false;
        return Response.json(
          {
            error: {
              code: "response_lost",
              message: "Controlled simulated response loss",
            },
          },
          { status: 500 },
        );
      }
      return response;
    };
  });
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Synthetic UI proof text");
  await page
    .getByRole("combobox", { name: "Delivery mode" })
    .selectOption("direct");
  await click(page.getByRole("button", { name: "Send message" }));
  await expect(
    page.getByRole("status").filter({ hasText: "Acceptance uncertain" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("send-uncertain.png"),
    fullPage: true,
  });
  await click(page.getByRole("button", { name: "Retry same request" }));
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Accepted — awaiting messaging confirmation" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("send-accepted-not-delivered.png"),
    fullPage: true,
  });
  await page.goto("/system");
  const audit = page.getByRole("article", {
    name: "Subscription subscription_audit",
  });
  await audit
    .getByRole("button", { name: /delivery_audit · uncertain/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(audit.getByLabel("Webhook delivery details")).toContainText(
    "delivery_audit · uncertain",
  );
  await click(page.getByRole("button", { name: "Load more subscriptions" }));
  const support = page.getByRole("article", {
    name: "Subscription subscription_support",
  });
  await click(
    support.getByRole("button", { name: /delivery_support · failed/ }),
  );
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await click(audit.getByRole("button", { name: "Retry webhook delivery" }));
  await expect(audit.getByLabel("Webhook delivery details")).toContainText(
    "delivery_audit · uncertain",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await click(audit.getByRole("button", { name: "Retry webhook delivery" }));
  await expect(audit.getByLabel("Webhook delivery details")).toContainText(
    "delivery_audit · pending",
  );
  await expect(support.getByLabel("Webhook delivery details")).toContainText(
    "delivery_support · failed",
  );
  await page.screenshot({
    path: info.outputPath("webhooks-independent.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const retry = support.getByRole("button", { name: "Retry webhook delivery" });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  await page.screenshot({ path: info.outputPath("webhooks-narrow.png") });
});
