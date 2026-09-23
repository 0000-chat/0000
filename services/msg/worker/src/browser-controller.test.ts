import { expect, test } from "bun:test";

import { browserFailureState, copyText, createLiveController, createOwnerControlsController, createPushEnrollmentController, createThemeController, handleAgentPromptCopy, normalizeOwnerManagementUrl, readPushBrowserId } from "./browser-controller";

const pushBrowserId = "123e4567-e89b-42d3-a456-426614174000";
const pushPublicKey = btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, index) => index + 1)))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const pushSubscription = {
  endpoint: "https://push.example.test/subscription/opaque",
  toJSON: () => ({
    endpoint: "https://push.example.test/subscription/opaque",
    expirationTime: null,
    keys: { auth: "MTIzNDU2Nzg5MDEyMzQ1Ng", p256dh: "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0BBQkNERUZHSElKS0xNTk5PUFFSU1RVVldYWVpbXF1eX2A" },
  }),
};

function pushStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

function pushJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

interface FakeSocket {
  closeCalls?: number;
  close?: () => void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
}

function socket(): FakeSocket {
  return { onclose: null, onerror: null, onmessage: null, onopen: null, readyState: 0 };
}

test("retains one WebSocket when repeated message frames arrive", () => {
  const sockets: FakeSocket[] = [];
  const frames: string[] = [];
  const controller = createLiveController({
    createSocket: () => { const next = socket(); sockets.push(next); return next; },
    onFrame: (frame) => frames.push(frame.type),
    onState: () => {},
    schedule: () => 1,
    cancel: () => {},
  });

  controller.connect();
  sockets[0].readyState = 1;
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: '{"type":"message.created"}' });
  sockets[0].onmessage?.({ data: '{"type":"message.created"}' });

  expect(sockets).toHaveLength(1);
  expect(frames).toEqual(["message.created", "message.created"]);
});

test("reports connecting, live, and one controlled reconnect", () => {
  const states: string[] = [];
  let scheduled: (() => void) | undefined;
  const sockets: FakeSocket[] = [];
  const controller = createLiveController({
    createSocket: () => { const next = socket(); sockets.push(next); return next; },
    onFrame: () => {}, onState: (state) => states.push(state),
    schedule: (callback) => { scheduled = callback; return 1; }, cancel: () => {},
  });

  controller.connect();
  sockets[0].readyState = 1;
  sockets[0].onopen?.();
  sockets[0].onclose?.();
  sockets[0].onclose?.();
  scheduled?.();

  expect(states).toEqual(["connecting", "live", "reconnecting", "connecting"]);
  expect(sockets).toHaveLength(2);
});

test("disconnect closes the socket and prevents a queued reconnect", () => {
  let scheduled: (() => void) | undefined;
  let created = 0;
  const first = socket();
  first.close = () => { first.closeCalls = (first.closeCalls ?? 0) + 1; };
  const controller = createLiveController({
    createSocket: () => { created += 1; return first; }, onFrame: () => {}, onState: () => {},
    schedule: (callback) => { scheduled = callback; return 1; }, cancel: () => {},
  });
  controller.connect();
  first.onerror?.();
  controller.disconnect();
  scheduled?.();

  expect(first.closeCalls).toBe(1);
  expect(created).toBe(1);
});

test("does not connect or schedule a reconnect while offline", () => {
  let online = false;
  let scheduled = 0;
  let created = 0;
  const first = socket();
  const controller = createLiveController({
    createSocket: () => { created += 1; return first; }, isOnline: () => online,
    onFrame: () => {}, onState: () => {}, schedule: () => { scheduled += 1; return 1; }, cancel: () => {},
  });

  expect(controller.connect()).toBe(false);
  expect(created).toBe(0);
  online = true;
  controller.connect();
  online = false;
  first.onclose?.();

  expect(scheduled).toBe(0);
});

test.each([
  [410, { terminal: true, notice: "This conversation was deleted or expired.", retry: false }],
  [429, { terminal: true, notice: "This conversation is full and cannot accept more messages.", retry: false }],
  [500, { terminal: false, notice: "The relay is temporarily unavailable. Try again.", retry: true }],
])("maps post failure %s to a truthful browser state", (status, expected) => {
  expect(browserFailureState(status, true)).toEqual(expected);
});

test("uses system theme when storage is blocked and updates on system changes", () => {
  const choices: string[] = [];
  let listener: (() => void) | undefined;
  const controller = createThemeController({
    media: { matches: false, addEventListener: (_event, callback) => { listener = callback; } },
    storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
    apply: (choice) => choices.push(choice),
  });

  controller.start();
  listener?.();
  controller.select("dark");

  expect(choices).toEqual(["system", "system", "dark"]);
});

test("keeps Live state when a message frame triggers an HTTP refresh", () => {
  const states: string[] = [];
  let refreshes = 0;
  let active: FakeSocket | undefined;
  const controller = createLiveController({
    createSocket: () => { active = socket(); return active; }, onFrame: () => { refreshes += 1; }, onState: (state) => states.push(state),
    schedule: () => 1, cancel: () => {},
  });

  controller.connect();
  active!.readyState = 1;
  active!.onopen?.();
  expect(states).toEqual(["connecting", "live"]);
  // The server frame is an HTTP refresh trigger, not a connection transition.
  active!.onmessage?.({ data: '{"type":"message.created"}' });

  expect(refreshes).toBe(1);
  expect(states).toEqual(["connecting", "live"]);
});

test("opens and selects the agent prompt when Clipboard API is missing", async () => {
  const events: string[] = [];

  const copied = await handleAgentPromptCopy({
    copyPrompt: () => copyText("prompt", { clipboard: undefined, documentObject: { body: { append: () => {} }, createElement: () => ({ remove: () => {}, select: () => {}, setAttribute: () => {}, style: {}, value: "" }), execCommand: () => false } }),
    focusPrompt: () => events.push("focus"), isModalOpen: () => false, openIntro: () => events.push("open"),
    selectPrompt: () => events.push("select"), showToast: (message) => events.push(message),
  });

  expect(copied).toBe(false);
  expect(events).toEqual(["open", "focus", "select", "Select and copy the prompt"]);
});

test("keeps owner controls in memory and rotates, disables, and copies the delegated invitation", async () => {
  const requests: Array<{ body: string; headers: Headers }> = [];
  const states: string[] = [];
  const responses = [
    { get_post_enabled: true, get_post_url: "https://msg.0000.chat/room/post?token=first-token", protocol_version: 1 },
    { get_post_enabled: true, get_post_url: "https://msg.0000.chat/room/post?token=rotated-token", protocol_version: 1 },
    { get_post_enabled: false, protocol_version: 1 },
  ];
  const controller = createOwnerControlsController({
    fetch: async (_input, init) => {
      requests.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(responses.shift()), { headers: { "content-type": "application/json" }, status: 200 });
    },
    manageUrl: "https://msg.0000.chat/manage/room/owner-token",
    onState: (state) => states.push(`${state.status}:${state.enabled}`),
    openApiUrl: "https://msg.0000.chat/openapi.json",
    publicRoomId: "room",
    publicRoomUrl: "https://msg.0000.chat/room",
  });

  expect(controller.state()).toMatchObject({ enabled: false, invitationAvailable: false, status: "disabled" });
  await controller.enable();
  expect(controller.state()).toMatchObject({ enabled: true, invitationAvailable: true, status: "enabled" });
  let copied = "";
  await controller.copyInvitation(async (value) => { copied = value; });
  expect(copied).toContain("Public room ID: room");
  expect(copied).toContain("OpenAPI import URL: https://msg.0000.chat/openapi.json");
  expect(copied).toContain("X-0000-Post-Token");
  expect(copied).toContain("Authentication value: first-token");
  expect(copied).toContain("Idempotency-Key");
  expect(copied).toContain("<write your message here>");
  expect(copied).not.toContain("/post?token=");

  await controller.rotate();
  expect(copied).toContain("first-token");
  await controller.copyInvitation(async (value) => { copied = value; });
  expect(copied).toContain("Authentication value: rotated-token");
  await controller.disable();
  expect(controller.state()).toMatchObject({ enabled: false, invitationAvailable: false, status: "disabled" });
  await expect(controller.copyInvitation(async () => {})).rejects.toThrow("Enable delegated posting");
  expect(requests.map((request) => JSON.parse(request.body).action)).toEqual(["enable", "rotate", "disable"]);
  expect(requests.every((request) => request.headers.get("content-type") === "application/json")).toBe(true);
  expect(states).toContain("enabled:true");
  expect(states).toContain("disabled:false");
});

test("validates management URLs before use and clears a stale invitation when rotation is uncertain", async () => {
  expect(normalizeOwnerManagementUrl("/manage/room/owner-token", "https://msg.0000.chat/room")).toBe("https://msg.0000.chat/manage/room/owner-token");
  expect(() => normalizeOwnerManagementUrl("https://evil.example/manage/room/owner-token", "https://msg.0000.chat/room")).toThrow("invalid private owner link");
  expect(() => normalizeOwnerManagementUrl("https://msg.0000.chat/manage/other/owner-token", "https://msg.0000.chat/room")).toThrow("invalid private owner link");

  let calls = 0;
  const controller = createOwnerControlsController({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return Response.json({ get_post_enabled: true, get_post_url: "https://msg.0000.chat/room/post?token=first-token", protocol_version: 1 });
      throw new Error("The owner request timed out.");
    },
    manageUrl: "https://msg.0000.chat/manage/room/owner-token",
    onState: () => {},
    openApiUrl: "https://msg.0000.chat/openapi.json",
    publicRoomId: "room",
    publicRoomUrl: "https://msg.0000.chat/room",
  });

  await controller.enable();
  await controller.copyInvitation(async () => {});
  await controller.rotate();
  expect(controller.state()).toMatchObject({ enabled: false, invitationAvailable: false, status: "error" });
  await expect(controller.copyInvitation(async () => {})).rejects.toThrow("Enable delegated posting");
});

test("waits for an active room-scope service worker before creating and registering a native subscription", async () => {
  const events: string[] = [];
  const requests: Array<{ body?: BodyInit | null; headers: Headers; method?: string }> = [];
  const storage = pushStorage();
  let resolveReady!: (registration: { scope: string; pushManager: { getSubscription(): Promise<null>; subscribe(options: { applicationServerKey: ArrayBuffer; userVisibleOnly: true }): Promise<typeof pushSubscription> } }) => void;
  const ready = new Promise<{ scope: string; pushManager: { getSubscription(): Promise<null>; subscribe(options: { applicationServerKey: ArrayBuffer; userVisibleOnly: true }): Promise<typeof pushSubscription> } }>((resolve) => { resolveReady = resolve; });
  let registered!: () => void;
  const registrationCompleted = new Promise<void>((resolve) => { registered = resolve; });
  const pushManager = {
    getSubscription: async () => { events.push("get-subscription"); return null; },
    subscribe: async (options: { applicationServerKey: ArrayBuffer; userVisibleOnly: true }) => {
      events.push("subscribe");
      expect(storage.value()).toBeNull();
      expect(options.userVisibleOnly).toBe(true);
      expect(new Uint8Array(options.applicationServerKey)).toHaveLength(65);
      expect(new Uint8Array(options.applicationServerKey)[0]).toBe(4);
      return pushSubscription;
    },
  };
  const states: string[] = [];
  const controller = createPushEnrollmentController({
    endpoint: "/room-capability/push-subscriptions",
    fetch: async (_input, init) => {
      requests.push({ body: init?.body, headers: new Headers(init?.headers), method: init?.method });
      return pushJsonResponse({ enrolled: true });
    },
    notifications: { permission: "default", requestPermission: async () => { events.push("permission"); return "granted"; } },
    onState: (state) => states.push(state.status),
    pushPublicKey,
    randomUUID: () => pushBrowserId,
    serviceWorker: {
      register: async (scriptUrl, options) => {
        events.push("register");
        expect(scriptUrl).toBe("/_msg/push-service-worker.js");
        expect(options).toEqual({ scope: "/" });
        registered();
        return { scope: "https://msg.example.test/" };
      },
      ready,
    },
    storage,
  });

  const enrollment = controller.enroll();
  await registrationCompleted;
  expect(events).toEqual(["permission", "register"]);
  expect(storage.value()).toBeNull();
  expect(requests).toHaveLength(0);
  resolveReady({ scope: "https://msg.example.test/", pushManager });
  await enrollment;

  expect(events).toEqual(["permission", "register", "get-subscription", "subscribe"]);
  expect(storage.value()).toBe(pushBrowserId);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe("POST");
  expect(requests[0].headers.get("x-msg-browser-id")).toBe(pushBrowserId);
  expect(JSON.parse(String(requests[0].body))).toEqual({
    endpoint: pushSubscription.endpoint,
    expirationTime: null,
    keys: pushSubscription.toJSON().keys,
  });
  expect(controller.state().status).toBe("enrolled");
  expect(controller.sourceId()).toBe(pushBrowserId);
  expect(states).toEqual(["enrolled"]);
});

test("permission denial does not register push or create a persistent browser identity", async () => {
  let registrationCalls = 0;
  let writes = 0;
  const controller = createPushEnrollmentController({
    endpoint: "/room/push-subscriptions",
    fetch: async () => pushJsonResponse({ enrolled: true }),
    notifications: { permission: "denied", requestPermission: async () => "denied" },
    onState: () => {},
    pushPublicKey,
    serviceWorker: { register: async () => { registrationCalls += 1; return {}; }, ready: Promise.resolve({}) },
    storage: { getItem: () => null, setItem: () => { writes += 1; } },
  });

  await controller.enroll();

  expect(controller.state()).toMatchObject({ status: "denied" });
  expect(registrationCalls).toBe(0);
  expect(writes).toBe(0);
});

test("storage failure after native subscription is acquired reports the enrollment failure without claiming success", async () => {
  let posts = 0;
  const controller = createPushEnrollmentController({
    endpoint: "/room/push-subscriptions",
    fetch: async () => { posts += 1; return pushJsonResponse({ enrolled: true }); },
    notifications: { permission: "granted", requestPermission: async () => "granted" },
    onState: () => {},
    pushPublicKey,
    randomUUID: () => pushBrowserId,
    serviceWorker: {
      register: async () => ({ scope: "https://msg.example.test/" }),
      ready: Promise.resolve({ scope: "https://msg.example.test/", pushManager: { getSubscription: async () => pushSubscription, subscribe: async () => pushSubscription } }),
    },
    storage: { getItem: () => null, setItem: () => { throw new Error("storage blocked"); } },
  });

  await controller.enroll();

  expect(controller.state().status).toBe("error");
  expect(controller.state().message).toContain("was not enrolled");
  expect(controller.state().message).toContain("private identity could not be saved");
  expect(posts).toBe(0);
});

test("refresh can find and remove a saved room enrollment when browser push is unavailable", async () => {
  const requests: Array<{ headers: Headers; method?: string }> = [];
  let nativeUnsubscribeCalls = 0;
  const existingSubscription = { ...pushSubscription, unsubscribe: async () => { nativeUnsubscribeCalls += 1; return true; } };
  const controller = createPushEnrollmentController({
    endpoint: "/room/push-subscriptions",
    fetch: async (_input, init) => {
      requests.push({ headers: new Headers(init?.headers), method: init?.method });
      return pushJsonResponse(init?.method === "DELETE" ? { removed: true } : { enrolled: true });
    },
    notifications: { permission: "denied", requestPermission: async () => "denied" },
    onState: () => {},
    serviceWorker: {
      register: async () => ({ scope: "https://msg.example.test/" }),
      ready: Promise.resolve({
        scope: "https://msg.example.test/",
        pushManager: { getSubscription: async () => existingSubscription, subscribe: async () => existingSubscription },
      }),
    },
    storage: pushStorage(pushBrowserId),
  });

  const found = await controller.refresh();
  await controller.unsubscribe();

  expect(found).toMatchObject({ status: "enrolled" });
  expect(controller.state()).toMatchObject({ status: "not_enrolled" });
  expect(requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
  expect(requests.every((request) => request.headers.get("x-msg-browser-id") === pushBrowserId)).toBe(true);
  expect(nativeUnsubscribeCalls).toBe(0);
  expect(readPushBrowserId({ getItem: () => pushBrowserId })).toBe(pushBrowserId);
  expect(readPushBrowserId({ getItem: () => { throw new Error("storage blocked"); } })).toBeUndefined();
});

test("stale room-status reads cannot overwrite a newer enroll or room unsubscribe", async () => {
  const pendingReads: Array<(response: Response) => void> = [];
  const storage = pushStorage(pushBrowserId);
  const controller = createPushEnrollmentController({
    endpoint: "/room/push-subscriptions",
    fetch: async (_input, init) => {
      if (init?.method === "GET") return await new Promise<Response>((resolve) => pendingReads.push(resolve));
      return pushJsonResponse(init?.method === "DELETE" ? { removed: true } : { enrolled: true });
    },
    notifications: { permission: "granted", requestPermission: async () => "granted" },
    onState: () => {},
    pushPublicKey,
    serviceWorker: {
      register: async () => ({ scope: "https://msg.example.test/" }),
      ready: Promise.resolve({
        scope: "https://msg.example.test/",
        pushManager: { getSubscription: async () => pushSubscription, subscribe: async () => pushSubscription },
      }),
    },
    storage,
  });

  const staleNotEnrolled = controller.refresh();
  expect(pendingReads).toHaveLength(1);
  await controller.enroll();
  expect(controller.state().status).toBe("enrolled");
  pendingReads[0]!(pushJsonResponse({ enrolled: false }));
  await staleNotEnrolled;
  expect(controller.state().status).toBe("enrolled");

  const staleEnrolled = controller.refresh();
  expect(pendingReads).toHaveLength(2);
  await controller.unsubscribe();
  expect(controller.state().status).toBe("not_enrolled");
  pendingReads[1]!(pushJsonResponse({ enrolled: true }));
  await staleEnrolled;
  expect(controller.state().status).toBe("not_enrolled");
});
