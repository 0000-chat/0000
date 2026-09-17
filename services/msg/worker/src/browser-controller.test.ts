import { expect, test } from "bun:test";

import { browserFailureState, copyText, createLiveController, createThemeController, handleAgentPromptCopy } from "./browser-controller";

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
