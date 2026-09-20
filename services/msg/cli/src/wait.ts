export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const MAX_WAIT_TIMEOUT_MS = 5 * 60_000;
export const WAIT_READ_LIMIT = 20;

export interface WaitCommand {
  readonly after: number;
  readonly conversationUrl: string;
  readonly timeoutMs?: number;
}

export interface WaitMessage {
  readonly sequence: number;
  readonly [key: string]: unknown;
}

export interface WaitNewMessagesResult {
  readonly event: "new_messages";
  readonly has_more: boolean;
  readonly latest_message: number;
  readonly messages: readonly WaitMessage[];
  readonly next_after: number;
  readonly oversized_message?: true;
  readonly through: number;
}

export interface WaitTimeoutResult {
  readonly event: "timeout";
  readonly latest_message?: number;
  readonly messages: readonly [];
  readonly next_after: number;
}

export type WaitResult = WaitNewMessagesResult | WaitTimeoutResult;

interface ReadPage {
  readonly has_more: boolean;
  readonly latest_message: number;
  readonly messages: readonly WaitMessage[];
  readonly next_after: number;
  readonly oversized_message?: true;
  readonly through: number;
}

export interface SocketEvent {
  readonly data?: string;
}

export interface WaitSocket {
  addEventListener(type: "close" | "error" | "message", listener: (event: SocketEvent) => void): void;
  close(): void;
}

export interface WaitOptions extends WaitCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly status?: (text: string) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly websocket: (url: string) => WaitSocket;
}

export class WaitSignalError extends Error {
  constructor() { super("The msg wait was interrupted."); }
}

export function parseWaitCommand(args: readonly string[]): WaitCommand {
  const usage = "Usage: msg wait <conversation-url> --after <nonnegative integer> [--timeout <duration>]";
  if (args[0] !== "wait" || args.length < 4) throw new Error(usage);
  const conversationUrl = validateConversationUrl(args[1] ?? "");
  const after = parseNonnegativeInteger(args[3] ?? "", "--after");
  if (args[2] !== "--after") throw new Error("--after must be a nonnegative safe integer.");
  const timeout = args.slice(4);
  if (timeout.length === 0) return { after, conversationUrl };
  if (timeout.length !== 2 || timeout[0] !== "--timeout") throw new Error(usage);
  return { after, conversationUrl, timeoutMs: parseDuration(timeout[1] ?? "") };
}

export async function waitForMessages(options: WaitOptions): Promise<WaitResult> {
  validateConversationUrl(options.conversationUrl);
  validateNonnegativeInteger(options.after, "after");
  const timeoutMs = validateTimeout(options.timeoutMs);
  if (options.signal?.aborted) throw new WaitSignalError();
  return await new Promise<WaitResult>((resolve, reject) => {
    const waitController = new AbortController();
    const readOptions: WaitOptions = { ...options, signal: waitController.signal };
    let settled = false;
    let reconnecting = false;
    let refreshPending = false;
    let refreshNeeded = false;
    let socket: WaitSocket | undefined;
    let cancelBackoff: (() => void) | undefined;
    let observedLatest: number | undefined;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const timerRef: { current?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      if (timerRef.current !== undefined) clearTimer(timerRef.current);
      cancelBackoff?.();
      cancelBackoff = undefined;
      options.signal?.removeEventListener("abort", interrupted);
      socket?.close();
      waitController.abort();
    };
    const finish = (result: WaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timeout = () => {
      const result: WaitTimeoutResult = {
        event: "timeout",
        messages: [],
        next_after: options.after,
        ...(observedLatest === undefined ? {} : { latest_message: observedLatest }),
      };
      finish(result);
    };
    const observe = (page: ReadPage): ReadPage => {
      if (!settled) observedLatest = page.latest_message;
      return page;
    };
    const deliver = (page: ReadPage) => {
      finish({ event: "new_messages", ...page });
    };
    const interrupted = () => fail(new WaitSignalError());

    const refresh = async (event: SocketEvent) => {
      if (settled) return;
      let frame: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data ?? "{}");
        if (!isRecord(parsed)) return;
        frame = parsed;
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The msg live frame was invalid."));
        return;
      }
      if (frame.type !== "ready" && !isSafeNonnegativeInteger(frame.latest_message)) return;
      if (refreshPending) {
        refreshNeeded = true;
        return;
      }
      refreshPending = true;
      try {
        do {
          refreshNeeded = false;
          const next = observe(await read(readOptions));
          if (next.messages.length > 0) {
            deliver(next);
            return;
          }
        } while (!settled && refreshNeeded);
      } catch (error) {
        if (!settled) fail(error instanceof Error ? error : new Error("The msg service read failed."));
      } finally {
        refreshPending = false;
      }
    };

    const reconnect = async (attempt: number) => {
      if (settled || reconnecting) return;
      reconnecting = true;
      socket?.close();
      try {
        const delay = Math.min(250 * 2 ** attempt, 5_000);
        options.status?.(`Reconnecting in ${delay}ms.`);
        if (options.sleep) await options.sleep(delay, readOptions.signal);
        else await sleep(delay, readOptions, (cancel) => { cancelBackoff = cancel; });
        cancelBackoff = undefined;
        if (settled) return;
        const result = observe(await read(readOptions));
        if (result.messages.length > 0) deliver(result);
        else connect(attempt + 1);
      } catch (error) {
        if (!settled) fail(error instanceof Error ? error : new Error("The msg live reconnection failed."));
      }
    };

    const connect = (attempt: number) => {
      reconnecting = false;
      if (settled) return;
      try {
        const connectedSocket = options.websocket(liveUrl(options.conversationUrl, options.after));
        socket = connectedSocket;
        connectedSocket.addEventListener("message", (event) => {
          if (socket !== connectedSocket) return;
          void refresh(event);
        });
        connectedSocket.addEventListener("error", () => {
          if (socket !== connectedSocket) return;
          void reconnect(attempt);
        });
        connectedSocket.addEventListener("close", () => {
          if (socket !== connectedSocket) return;
          void reconnect(attempt);
        });
      } catch {
        void reconnect(attempt);
      }
    };

    options.signal?.addEventListener("abort", interrupted, { once: true });
    timerRef.current = setTimer(timeout, timeoutMs);
    if (settled && timerRef.current !== undefined) clearTimer(timerRef.current);
    if (settled) return;
    void read(readOptions).then((result) => {
      if (settled) return;
      const page = observe(result);
      if (page.messages.length > 0) deliver(page);
      else {
        options.status?.("Waiting for new messages.");
        connect(0);
      }
    }, (error: unknown) => {
      if (!settled) fail(error instanceof Error ? error : new Error("The msg service read failed."));
    });
  });
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/u.exec(value);
  if (!match) throw new Error("--timeout must be a positive duration no greater than 5 minutes.");
  const amount = Number(match[1]);
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  const timeoutMs = amount * unitMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error("--timeout must be a positive duration no greater than 5 minutes.");
  }
  return timeoutMs;
}

function validateTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WAIT_TIMEOUT_MS) {
    throw new Error("timeoutMs must be a positive safe integer no greater than 300000.");
  }
  return value;
}

function parseNonnegativeInteger(value: string, field: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${field} must be a nonnegative safe integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be a nonnegative safe integer.`);
  return parsed;
}

function validateNonnegativeInteger(value: number, _field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("after must be a nonnegative safe integer.");
  return value;
}

function readUrl(conversationUrl: string, after: number): string {
  const url = new URL(conversationUrl);
  url.searchParams.set("after", String(after));
  url.searchParams.set("limit", String(WAIT_READ_LIMIT));
  return url.toString();
}

function liveUrl(conversationUrl: string, after: number): string {
  const url = new URL(conversationUrl);
  url.protocol = "wss:";
  url.pathname = `${url.pathname}/live`;
  url.search = "";
  url.searchParams.set("after", String(after));
  return url.toString();
}

async function read(options: WaitOptions): Promise<ReadPage> {
  const response = await options.fetch(readUrl(options.conversationUrl, options.after), {
    headers: { accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The msg service returned HTTP ${response.status}.`);
  }
  const value: unknown = await response.json();
  return validateReadPage(value, options.after);
}

function validateReadPage(value: unknown, after: number): ReadPage {
  if (!isRecord(value) || value.protocol_version !== 1 || !isSafeNonnegativeInteger(value.latest_message) || !Array.isArray(value.messages)) {
    throw new Error("The msg service returned an invalid bounded read response.");
  }
  if (!Object.hasOwn(value, "next_after") || !Object.hasOwn(value, "has_more") || !Object.hasOwn(value, "through")) {
    throw new Error("The msg service does not support bounded reads; update the server before waiting.");
  }
  const latest = value.latest_message;
  const nextAfter = value.next_after;
  const through = value.through;
  if (!isSafeNonnegativeInteger(nextAfter) || !isSafeNonnegativeInteger(through) || typeof value.has_more !== "boolean") {
    throw new Error("The msg service returned invalid bounded page metadata.");
  }
  if (through < after || through > latest || nextAfter < after || nextAfter > through || latest < after) {
    throw new Error("The msg service returned invalid bounded page metadata.");
  }
  if (value.messages.length > WAIT_READ_LIMIT) {
    throw new Error("The msg service returned more messages than the requested page limit.");
  }
  const messages: WaitMessage[] = [];
  for (let index = 0; index < value.messages.length; index += 1) {
    const message = value.messages[index];
    if (!isWaitMessage(message)) throw new Error("The msg service returned an invalid bounded read response.");
    if (index > 0 && messages[index - 1]!.sequence >= message.sequence) {
      throw new Error("The msg service returned messages out of sequence.");
    }
    if (message.sequence <= after || message.sequence > through) {
      throw new Error("The msg service returned messages outside the bounded page.");
    }
    messages.push(message);
  }
  const lastSequence = messages.at(-1)?.sequence ?? after;
  if (nextAfter !== lastSequence) throw new Error("The msg service returned an invalid continuation cursor.");
  if (value.has_more && (messages.length === 0 || nextAfter <= after)) {
    throw new Error("The msg service returned a non-advancing continuation page.");
  }
  if (value.oversized_message !== undefined && (value.oversized_message !== true || messages.length !== 1)) {
    throw new Error("The msg service returned an invalid oversized-message marker.");
  }
  return {
    has_more: value.has_more,
    latest_message: latest,
    messages,
    next_after: nextAfter,
    ...(value.oversized_message === true ? { oversized_message: true } : {}),
    through,
  };
}

function isWaitMessage(value: unknown): value is WaitMessage {
  return isRecord(value) && isSafePositiveInteger(value.sequence);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return isSafeNonnegativeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(delayMs: number, options: WaitOptions, registerCancel: (cancel: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new WaitSignalError());
      return;
    }
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    let complete = false;
    const cancel = () => {
      if (complete) return;
      complete = true;
      clearTimer(timer);
      options.signal?.removeEventListener("abort", interrupted);
      resolve();
    };
    const interrupted = () => {
      cancel();
      reject(new WaitSignalError());
    };
    const timer = setTimer(() => {
      if (complete) return;
      complete = true;
      options.signal?.removeEventListener("abort", interrupted);
      resolve();
    }, delayMs);
    registerCancel(cancel);
    options.signal?.addEventListener("abort", interrupted, { once: true });
  });
}

export function validateConversationUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The conversation URL must be https://msg.0000.chat/{room}."); }
  if (url.protocol !== "https:" || url.hostname !== "msg.0000.chat" || url.port || url.username || url.password || url.search || url.hash || !/^\/[^/]+$/.test(url.pathname)) {
    throw new Error("The conversation URL must be https://msg.0000.chat/{room}.");
  }
  return url.toString();
}
