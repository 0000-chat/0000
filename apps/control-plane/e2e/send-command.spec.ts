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

test("retries an accepted direct command with the same key after response loss", async ({ page }) => {
  await page.goto("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const idempotencyKeys: string[] = [];
    (window as Window & { __retryTestKeys?: string[] }).__retryTestKeys = idempotencyKeys;
    let firstResponse = true;

    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "POST"
        && request.url.includes("/api/v1/conversations/conversation_human_telegram_alex/messages")
      ) {
        idempotencyKeys.push(request.headers.get("Idempotency-Key") ?? "");
        const response = await originalFetch(request);
        if (firstResponse) {
          firstResponse = false;
          if (response.status !== 202) {
            throw new Error(`Expected simulated acceptance, received ${response.status}`);
          }
          return new Response(JSON.stringify({
            error: {
              code: "response_lost",
              message: "The simulated response was lost after acceptance.",
            },
          }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return response;
      }
      return originalFetch(request);
    };
  });

  await page.getByRole("textbox", { name: "Message" }).fill("Hello from the simulated Human identity");
  await page.getByRole("combobox", { name: "Delivery mode" }).selectOption("direct");
  const sendButton = page.getByRole("button", { name: "Send message" });
  await sendButton.click();
  await expect(page.getByRole("status").filter({ hasText: "could not be accepted" })).toBeVisible();
  await sendButton.click();

  await expect(page.getByRole("status").filter({ hasText: "Accepted — awaiting messaging confirmation" })).toBeVisible();
  await page.getByRole("link", { name: "Activity", exact: true }).first().click();
  await expect(page.getByRole("list", { name: "Command activity" }).getByRole("listitem")).toHaveCount(2);
  const idempotencyKeys = await page.evaluate(
    () => (window as Window & { __retryTestKeys?: string[] }).__retryTestKeys ?? [],
  );
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
});

test("previews paced delivery and records its accepted command phase", async ({ page }) => {
  await page.goto("/conversations/conversation_human_telegram_alex?identity=identity_human&channel=connection_human_telegram");
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
  await expect(page.getByRole("article").filter({ hasText: "Messenger" }).getByRole("button", { name: /Simulation only.*Reconnect/ })).toBeDisabled();

  await page.goto("/system");
  await page.getByRole("button", { name: "Reset simulated scenario" }).click();
  await expect(page.getByRole("status", { name: "Simulation reset complete" })).toBeVisible();
});
