export type LiveState = "connecting" | "live" | "reconnecting";

export interface SocketLike {
  close?(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
}

export interface LiveControllerOptions {
  readonly cancel: (timer: number) => void;
  readonly createSocket: () => SocketLike;
  readonly isOnline?: () => boolean;
  readonly onFrame: (frame: { latest_message?: number; type?: string }) => void;
  readonly onState: (state: LiveState) => void;
  readonly schedule: (callback: () => void, delayMs: number) => number;
}

export function createLiveController(options: LiveControllerOptions) {
  let socket: SocketLike | undefined;
  let reconnectTimer: number | undefined;
  let stopped = false;
  const reconnect = () => {
    reconnectTimer = undefined;
    connect();
  };
  const scheduleReconnect = () => {
    if (stopped || options.isOnline?.() === false) return;
    if (reconnectTimer !== undefined) return;
    options.onState("reconnecting");
    reconnectTimer = options.schedule(reconnect, 2_500);
  };
  const connect = () => {
    if (stopped || options.isOnline?.() === false) return false;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return false;
    if (reconnectTimer !== undefined) {
      options.cancel(reconnectTimer);
      reconnectTimer = undefined;
    }
    options.onState("connecting");
    const next = options.createSocket();
    socket = next;
    next.onopen = () => options.onState("live");
    next.onmessage = (event) => {
      try { options.onFrame(JSON.parse(event.data) as { type?: string }); } catch { /* Ignore malformed server frames. */ }
    };
    next.onerror = scheduleReconnect;
    next.onclose = () => {
      if (socket === next) socket = undefined;
      scheduleReconnect();
    };
    return true;
  };
  return { connect, disconnect: () => {
    stopped = true;
    if (reconnectTimer !== undefined) options.cancel(reconnectTimer);
    reconnectTimer = undefined;
    socket?.close?.();
    socket = undefined;
  } };
}

export function browserFailureState(status: number, online: boolean): { notice: string; retry: boolean; terminal: boolean } {
  if (!online) return { notice: "You are offline. Your reply will stay pending until you reconnect.", retry: true, terminal: false };
  if (status === 410) return { notice: "This conversation was deleted or expired.", retry: false, terminal: true };
  if (status === 429) return { notice: "This conversation is full and cannot accept more messages.", retry: false, terminal: true };
  if (status === 401 || status === 403) return { notice: "This room needs a valid link.", retry: false, terminal: true };
  if (status === 404) return { notice: "This conversation does not exist.", retry: false, terminal: true };
  return { notice: "The relay is temporarily unavailable. Try again.", retry: true, terminal: false };
}

export interface ThemeControllerOptions {
  readonly apply: (choice: "dark" | "light" | "system") => void;
  readonly media: { readonly matches: boolean; addEventListener(event: "change", callback: () => void): void };
  readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function createThemeController(options: ThemeControllerOptions) {
  let choice: "dark" | "light" | "system" = "system";
  const normalize = (value: string | null): "dark" | "light" | "system" => value === "dark" || value === "light" || value === "system" ? value : "system";
  return {
    select(next: "dark" | "light" | "system") {
      choice = next;
      try { options.storage.setItem("0000:theme-choice:v1", choice); } catch { /* Storage is optional. */ }
      options.apply(choice);
    },
    start() {
      try { choice = normalize(options.storage.getItem("0000:theme-choice:v1")); } catch { choice = "system"; }
      options.media.addEventListener("change", () => { if (choice === "system") options.apply(choice); });
      options.apply(choice);
    },
  };
}

export interface CopyDocument {
  readonly body: { append(node: unknown): void };
  createElement(name: "textarea"): { remove(): void; select(): void; setAttribute(name: string, value: string): void; style: Record<string, string>; value: string };
  execCommand(command: "copy"): boolean;
}

export async function copyText(value: string, options: { clipboard?: { writeText(value: string): Promise<void> }; documentObject: CopyDocument }): Promise<void> {
  if (options.clipboard?.writeText) {
    await options.clipboard.writeText(value);
    return;
  }
  const field = options.documentObject.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  options.documentObject.body.append(field);
  field.select();
  const copied = options.documentObject.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("copy_failed");
}

export async function handleAgentPromptCopy(options: {
  readonly copyPrompt: () => Promise<void>;
  readonly focusPrompt: () => void;
  readonly isModalOpen: () => boolean;
  readonly openIntro: () => void;
  readonly selectPrompt: () => void;
  readonly showToast: (message: string) => void;
}): Promise<boolean> {
  try {
    await options.copyPrompt();
    options.showToast("Agent prompt copied");
    return true;
  } catch {
    if (!options.isModalOpen()) options.openIntro();
    options.focusPrompt();
    options.selectPrompt();
    options.showToast("Select and copy the prompt");
    return false;
  }
}

export interface WebhookPanelDelivery {
  readonly attempt_count: number;
  readonly attempted_at: string | null;
  readonly completed_at: string | null;
  readonly failure_category: string | null;
  readonly status: string;
}

export interface WebhookPanelEntry {
  readonly deliveries: readonly WebhookPanelDelivery[];
  readonly id: string;
  readonly status: string;
  readonly url: string;
}

export interface WebhookPanelControllerOptions {
  readonly endpoint: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onEntries: (entries: readonly WebhookPanelEntry[]) => void;
  readonly onSecret: (secret: string) => void;
}

/** Room-scoped webhook operations used by the human Notifications panel. */
export function createWebhookPanelController(options: WebhookPanelControllerOptions) {
  let busy = false;
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

  async function request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    const response = await options.fetch(`${options.endpoint}${path}`, { ...init, headers });
    let value: unknown;
    try { value = await response.json(); } catch { value = undefined; }
    if (!response.ok) {
      const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : `The request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    if (value === undefined) throw new Error("The service returned an invalid webhook response.");
    return value;
  }

  function parseEntries(value: unknown): readonly WebhookPanelEntry[] {
    if (!isRecord(value) || !Array.isArray(value.webhooks)) throw new Error("The service returned an invalid webhook list.");
    for (const entry of value.webhooks) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.url !== "string" || typeof entry.status !== "string" || !Array.isArray(entry.deliveries)) {
        throw new Error("The service returned an invalid webhook list.");
      }
    }
    return value.webhooks as WebhookPanelEntry[];
  }

  async function refreshEntries(): Promise<readonly WebhookPanelEntry[]> {
    const entries = parseEntries(await request("", { method: "GET" }));
    options.onEntries(entries);
    return entries;
  }

  async function runExclusive<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    busy = true;
    options.onBusyChange(true);
    try {
      return await operation();
    } finally {
      busy = false;
      options.onBusyChange(false);
    }
  }

  return {
    async list() {
      return await runExclusive(refreshEntries);
    },
    async create(url: string) {
      return await runExclusive(async () => {
        const value = await request("", {
          body: JSON.stringify({ url }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!isRecord(value) || typeof value.secret !== "string" || !isRecord(value.webhook)) {
          throw new Error("The service returned an invalid webhook creation result.");
        }
        options.onSecret(value.secret);
        return await refreshEntries();
      });
    },
    async remove(id: string) {
      return await runExclusive(async () => {
        await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
        return await refreshEntries();
      });
    },
  };
}
