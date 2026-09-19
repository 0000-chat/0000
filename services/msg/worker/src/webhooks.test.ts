import { expect, test } from "bun:test";

import { discardWebhookResponseBody, normalizeWebhookUrl, redactWebhookUrl, signWebhookPayload, webhookRequestTarget } from "./webhooks";

test("accepts public HTTPS webhook destinations and rejects local targets", () => {
  expect(normalizeWebhookUrl("https://receiver.example.com/hooks")).toBe("https://receiver.example.com/hooks");
  expect(normalizeWebhookUrl("https://1.1.1.1/hooks")).toBe("https://1.1.1.1/hooks");
  expect(normalizeWebhookUrl("https://[2606:4700:4700::1111]/hooks")).toBe("https://[2606:4700:4700::1111]/hooks");

  for (const value of [
    "http://receiver.example.com/hooks",
    "https://localhost/hooks",
    "https://receiver.local/hooks",
    "https://127.0.0.1/hooks",
    "https://192.0.2.1/hooks",
    "https://[fc00::1]/hooks",
    "https://[::1]/hooks",
    "https://receiver.example.com/hooks#fragment",
  ]) {
    expect(normalizeWebhookUrl(value)).toBeUndefined();
  }
});

test("redacts user information and query values in endpoint URLs", () => {
  const shown = redactWebhookUrl("https://alice:password@receiver.example.com/hooks?token=first-secret&sig=second-secret");

  expect(shown).toBe("https://redacted:redacted@receiver.example.com/hooks?token=redacted&sig=redacted");
  expect(shown).not.toContain("alice");
  expect(shown).not.toContain("password");
  expect(shown).not.toContain("first-secret");
  expect(shown).not.toContain("second-secret");
});

test("moves URL credentials to the outbound authorization header without logging them in the URL", () => {
  const target = webhookRequestTarget("https://alice:p%40ss@receiver.example.com/hooks?token=query-secret");

  expect(target.url).toBe("https://receiver.example.com/hooks?token=query-secret");
  expect(target.authorization).toMatch(/^Basic /u);
  expect(target.url).not.toContain("alice");
  expect(target.url).not.toContain("p%40ss");
});

test("signs the timestamp and exact JSON body", async () => {
  const secret = "dGhpcy1pcy1hLXRlc3Qtc2VjcmV0";
  const signature = await signWebhookPayload(secret, "1720000000", '{"message":"hello"}');

  expect(signature).toMatch(/^v1=[0-9a-f]{64}$/u);
  expect(await signWebhookPayload(secret, "1720000000", '{"message":"changed"}')).not.toBe(signature);
  expect(await signWebhookPayload(secret, "1720000001", '{"message":"hello"}')).not.toBe(signature);
});


test("discards webhook response bodies without reading or retaining their content", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("untrusted response body"));
    },
    cancel() {
      cancelled = true;
    },
  }), { status: 502 });

  await discardWebhookResponseBody(response);

  expect(cancelled).toBe(true);
});
