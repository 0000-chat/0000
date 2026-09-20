export interface WaitCommand {
  readonly after: number;
  readonly conversationUrl: string;
  readonly timeoutMs?: number;
}

interface ReadResult {
  readonly latest_message: number;
  readonly messages: readonly unknown[];
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
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly status?: (text: string) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly websocket: (url: string) => WaitSocket;
}

export class WaitSignalError extends Error {
  constructor() { super("The msg wait was interrupted."); }
}

export function parseWaitCommand(args: readonly string[]): WaitCommand {
  if (args[0] !== "wait" || args.length < 4) throw new Error("Usage: msg wait <conversation-url> --after <nonnegative integer> [--timeout <duration>]");
  const conversationUrl = validateConversationUrl(args[1] ?? "");
  if (args[2] !== "--after" || !/^(?:0|[1-9][0-9]*)$/u.test(args[3] ?? "") || !Number.isSafeInteger(Number(args[3]))) throw new Error("--after must be a nonnegative safe integer.");
  const timeout = args.slice(4);
  if (timeout.length === 0) return { after: Number(args[3]), conversationUrl };
  if (timeout.length !== 2 || timeout[0] !== "--timeout") throw new Error("Usage: msg wait <conversation-url> --after <nonnegative integer> [--timeout <duration>]");
  const timeoutMs = parseDuration(timeout[1] ?? "");
  return { after: Number(args[3]), conversationUrl, timeoutMs };
}

export async function waitForMessages(options: WaitOptions): Promise<ReadResult> {
  validateConversationUrl(options.conversationUrl);
  if (options.signal?.aborted) throw new WaitSignalError();
  return await new Promise<ReadResult>((resolve, reject) => {
    const waitController = new AbortController();
    const readOptions = { ...options, signal: waitController.signal };
    let settled = false;
    let reconnecting = false;
    let refreshPending = false;
    let socket: WaitSocket | undefined;
    let cancelBackoff: (() => void) | undefined;
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const timer = options.timeoutMs === undefined ? undefined : setTimer(() => fail(new Error("The msg wait timed out.")), options.timeoutMs);
    const finish = (result: ReadResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      cancelBackoff?.();
      cancelBackoff = undefined;
      options.signal?.removeEventListener("abort", interrupted);
      socket?.close();
      waitController.abort();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimer(timer);
      cancelBackoff?.();
      cancelBackoff = undefined;
      options.signal?.removeEventListener("abort", interrupted);
      socket?.close();
      waitController.abort();
      reject(error);
    };
    const refresh = async (event: SocketEvent) => {
      let frame: { latest_message?: unknown; type?: unknown };
      try {
        frame = JSON.parse(event.data ?? "{}") as { latest_message?: unknown; type?: unknown };
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The msg live frame was invalid."));
        return;
      }
      if (frame.type !== "ready" && typeof frame.latest_message !== "number") return;
      if (refreshPending) return;
      refreshPending = true;
      try {
        const next = await read(readOptions);
        if (next.messages.length > 0) finish(next);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The msg service read failed."));
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
        await (options.sleep ?? ((delayMs) => sleep(delayMs, readOptions, (cancel) => { cancelBackoff = cancel; })))(delay);
        cancelBackoff = undefined;
        if (settled) return;
        const result = await read(readOptions);
        if (result.messages.length > 0) finish(result);
        else connect(attempt + 1);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("The msg live reconnection failed."));
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
    const interrupted = () => fail(new WaitSignalError());
    options.signal?.addEventListener("abort", interrupted, { once: true });
    void read(readOptions).then((result) => {
      if (result.messages.length > 0) finish(result);
      else {
        options.status?.("Waiting for new messages.");
        connect(0);
      }
    }, (error: unknown) => fail(error instanceof Error ? error : new Error("The msg service read failed.")));
  });
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match || Number(match[1]) <= 0) throw new Error("--timeout must be a positive duration such as 30s.");
  return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const)[match[2] as "ms" | "s" | "m" | "h"];
}

function readUrl(conversationUrl: string, after: number): string {
  const url = new URL(conversationUrl);
  url.searchParams.set("after", String(after));
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

async function read(options: WaitOptions): Promise<ReadResult> {
  const response = await options.fetch(readUrl(options.conversationUrl, options.after), {
    headers: { accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`The msg service returned HTTP ${response.status}.`);
  const result = await response.json() as ReadResult;
  if (!Number.isSafeInteger(result.latest_message) || !Array.isArray(result.messages)) throw new Error("The msg service returned an invalid read response.");
  return result;
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
