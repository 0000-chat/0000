import { expect, test } from "bun:test";

import { pushServiceWorkerResponse, type MsgPushPayload } from "./push-service-worker";

interface FakeWindowClient {
  focused?: boolean;
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
  const visibleNotifications = new Map<string, FakeNotificationCall>();
  const openedUrls: string[] = [];
  const source = pushServiceWorkerResponse();

  const serviceWorker: FakeServiceWorker = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: { origin },
    registration: {
      async showNotification(title, options) {
        const notification = { title, options };
        notifications.push(notification);
        const tag = typeof options.tag === "string" && options.tag.length > 0 ? options.tag : `untagged-${notifications.length}`;
        visibleNotifications.set(tag, notification);
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
      visibleNotifications: () => [...visibleNotifications.values()],
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

function roomPayload(roomUrl: string, roomId = "550e8400-e29b-41d4-a716-446655440000"): MsgPushPayload {
  return {
    type: "message.created",
    room_id: roomId,
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
    options: { data: { room_url: `https://msg.0000.chat/${roomId}?view=agent` }, tag: "msg-room-550e8400-e29b-41d4-a716-446655440000" },
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

test("suppresses a push when any same-room tab is focused, across human and agent views", async () => {
  const roomId = "H".repeat(43);
  const otherRoomId = "I".repeat(43);
  const client = (url: string, focused: boolean): FakeWindowClient => ({
    focused,
    url,
    async navigate(nextUrl) { this.url = nextUrl; return this; },
    async focus() { this.focused = true; return this; },
  });
  const harness = await createHarness([
    client(`https://msg.0000.chat/${roomId}?view=agent`, false),
    client(`https://msg.0000.chat/${otherRoomId}?view=human`, true),
    client(`https://msg.0000.chat/${roomId}`, true),
  ]);

  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${roomId}?view=human`));

  expect(harness.notifications).toEqual([]);
  expect(harness.visibleNotifications()).toEqual([]);
});

test("does not suppress for an unfocused room tab or a focused different room", async () => {
  const roomId = "J".repeat(43);
  const otherRoomId = "K".repeat(43);
  const client = (url: string, focused: boolean): FakeWindowClient => ({
    focused,
    url,
    async navigate(nextUrl) { this.url = nextUrl; return this; },
    async focus() { this.focused = true; return this; },
  });
  const harness = await createHarness([
    client(`https://msg.0000.chat/${roomId}?view=human`, false),
    client(`https://msg.0000.chat/${otherRoomId}`, true),
  ]);

  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${roomId}`));

  expect(harness.notifications).toEqual([{
    title: "New message in msg",
    options: { data: { room_url: `https://msg.0000.chat/${roomId}?view=human` }, tag: "msg-room-550e8400-e29b-41d4-a716-446655440000" },
  }]);
});

test("replaces a visible alert for the same room while keeping another room alert", async () => {
  const firstRoom = "L".repeat(43);
  const secondRoom = "M".repeat(43);
  const firstRoomId = "550e8400-e29b-41d4-a716-446655440000";
  const secondRoomId = "123e4567-e89b-42d3-a456-426614174000";
  const harness = await createHarness();

  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${firstRoom}?view=human`, firstRoomId));
  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${secondRoom}`, secondRoomId));
  await harness.dispatchPush(roomPayload(`https://msg.0000.chat/${firstRoom}?view=agent`, firstRoomId));

  expect(harness.notifications.map(({ options }) => options.tag)).toEqual([
    `msg-room-${firstRoomId}`,
    `msg-room-${secondRoomId}`,
    `msg-room-${firstRoomId}`,
  ]);
  expect(harness.visibleNotifications()).toHaveLength(2);
  expect(harness.visibleNotifications().map(({ title }) => title)).toEqual(["New message in msg", "New message in msg"]);
  expect(harness.visibleNotifications().find(({ options }) => options.tag === `msg-room-${firstRoomId}`)?.options.data).toEqual({
    room_url: `https://msg.0000.chat/${firstRoom}?view=agent`,
  });
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
