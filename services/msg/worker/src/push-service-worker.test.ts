import { expect, test } from "bun:test";

import { pushServiceWorkerResponse, type MsgPushPayload } from "./push-service-worker";

interface FakeWindowClient {
  url: string;
  navigate(url: string): Promise<FakeWindowClient | null>;
  focus(): Promise<FakeWindowClient>;
}

interface FakeNotification {
  readonly data?: unknown;
  close(): void;
}

interface FakeEvent {
  readonly data?: { json(): unknown } | null;
  readonly notification?: FakeNotification;
  waitUntil(promise: Promise<unknown>): void;
}

interface FakeNotificationCall {
  readonly title: string;
  readonly options: Record<string, unknown>;
}

interface FakeServiceWorker {
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  readonly location: { readonly origin: string };
  readonly registration: {
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
  };
  readonly clients: {
    matchAll(options: { readonly type: "window"; readonly includeUncontrolled: true }): Promise<readonly FakeWindowClient[]>;
    openWindow(url: string): Promise<FakeWindowClient | null>;
  };
}

function createHarness(existingClients: readonly FakeWindowClient[] = []) {
  const origin = "https://msg.0000.chat";
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const notifications: FakeNotificationCall[] = [];
  const openedUrls: string[] = [];
  const source = pushServiceWorkerResponse();

  const serviceWorker: FakeServiceWorker = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: { origin },
    registration: {
      async showNotification(title, options) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return existingClients;
      },
      async openWindow(url) {
        openedUrls.push(url);
        return null;
      },
    },
  };

  return source.text().then((script) => {
    new Function("self", script)(serviceWorker);

    return {
      notifications,
      openedUrls,
      dispatchPush(data: unknown) {
        let lifetime: Promise<unknown> | undefined;
        listeners.get("push")?.({
          data: { json: () => data },
          waitUntil(promise) {
            lifetime = promise;
          },
        });
        return lifetime;
      },
      dispatchClick(data: unknown) {
        let lifetime: Promise<unknown> | undefined;
        let closed = false;
        listeners.get("notificationclick")?.({
          notification: {
            data,
            close() {
              closed = true;
            },
          },
          waitUntil(promise) {
            lifetime = promise;
          },
        });
        return { closed: () => closed, lifetime };
      },
    };
  });
}

function roomPayload(roomUrl: string): MsgPushPayload {
  return {
    type: "message.created",
    room_id: "550e8400-e29b-41d4-a716-446655440000",
    room_url: roomUrl,
  };
}

test("serves executable JavaScript with root scope and revalidation headers", async () => {
  const response = pushServiceWorkerResponse();
  const source = await response.text();

  expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("service-worker-allowed")).toBe("/");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(() => new Function("self", source)).not.toThrow();
});

test("shows only the generic notification and focuses a matching room client with no view query", async () => {
  const roomId = "A".repeat(43);
  const navigations: string[] = [];
  let focusCount = 0;
  const matchingClient: FakeWindowClient = {
    url: `https://msg.0000.chat/${roomId}`,
    async navigate(url) {
      navigations.push(url);
      this.url = url;
      return this;
    },
    async focus() {
      focusCount += 1;
      return this;
    },
  };
  const harness = await createHarness([matchingClient]);
  const payload = roomPayload(`https://msg.0000.chat/${roomId}?view=agent`);

  await harness.dispatchPush(payload);

  expect(harness.notifications).toEqual([{
    title: "New message in msg",
    options: { data: { room_url: `https://msg.0000.chat/${roomId}?view=agent` } },
  }]);

  const click = harness.dispatchClick(harness.notifications[0]?.options.data);
  await click.lifetime;

  expect(click.closed()).toBe(true);
  expect(navigations).toEqual([]);
  expect(focusCount).toBe(1);
  expect(harness.openedUrls).toEqual([]);
});

test("focuses an already open room with a valid view without navigating or discarding its state", async () => {
  const roomId = "D".repeat(43);
  const navigations: string[] = [];
  let focusCount = 0;
  const matchingClient: FakeWindowClient = {
    url: `https://msg.0000.chat/${roomId}?view=human`,
    async navigate(url) {
      navigations.push(url);
      this.url = url;
      return this;
    },
    async focus() {
      focusCount += 1;
      return this;
    },
  };
  const harness = await createHarness([matchingClient]);

  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${roomId}?view=human`));
  const click = harness.dispatchClick(harness.notifications[0]?.options.data);
  await click.lifetime;

  expect(click.closed()).toBe(true);
  expect(navigations).toEqual([]);
  expect(focusCount).toBe(1);
  expect(harness.openedUrls).toEqual([]);
});

test("opens a human room view when no valid view was supplied", async () => {
  const roomId = "B".repeat(43);
  const harness = await createHarness();

  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${roomId}`));
  const click = harness.dispatchClick(harness.notifications[0]?.options.data);
  await click.lifetime;

  expect(click.closed()).toBe(true);
  expect(harness.openedUrls).toEqual([`https://msg.0000.chat/${roomId}?view=human`]);
});

test("ignores malformed payloads and rejects external, credentialed, and non-room destinations", async () => {
  const harness = await createHarness();
  const roomId = "C".repeat(43);
  const invalidPayloads = [
    null,
    { ...roomPayload(`https://msg.0000.chat/${roomId}`), message: { content: "private preview" } },
    { ...roomPayload(`https://msg.0000.chat/${roomId}`), room_id: "not-a-uuid" },
    roomPayload("https://outside.example/" + roomId),
    roomPayload(`https://user:secret@msg.0000.chat/${roomId}`),
    roomPayload("https://msg.0000.chat/_msg/push-service-worker.js"),
    roomPayload(`https://msg.0000.chat/${roomId}/extra`),
    roomPayload(`https://msg.0000.chat/other/../${roomId}`),
    roomPayload(`https://msg.0000.chat/%2f${roomId}`),
  ];

  for (const payload of invalidPayloads) {
    await harness.dispatchPush(payload);
  }

  expect(harness.notifications).toEqual([]);

  const click = harness.dispatchClick({ room_url: `https://outside.example/${roomId}` });
  await click.lifetime;

  expect(click.closed()).toBe(true);
  expect(harness.openedUrls).toEqual([]);
});
