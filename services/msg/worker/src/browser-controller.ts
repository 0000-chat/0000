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
  readonly created_at: string;
  readonly event_id: string;
  readonly message_sequence: number;
  readonly attempts: readonly {
    readonly attempt_number: number;
    readonly attempted_at: string;
    readonly completed_at: string | null;
    readonly failure_category: string | null;
    readonly status: string;
  }[];
  readonly attempt_count: number;
  readonly attempted_at: string | null;
  readonly cancelled_at: string | null;
  readonly completed_at: string | null;
  readonly failure_category: string | null;
  readonly next_attempt_at: string | null;
  readonly retry_expires_at: string;
  readonly status: string;
}

export interface WebhookPanelEntry {
  readonly deliveries: readonly WebhookPanelDelivery[];
  readonly disabled_at: string | null;
  readonly failure_started_at: string | null;
  readonly id: string;
  readonly last_failure_at: string | null;
  readonly last_success_at: string | null;
  readonly recovered_at: string | null;
  readonly status: string;
  readonly url: string;
}

export interface WebhookPanelControllerOptions {
  readonly endpoint: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onEntries: (entries: readonly WebhookPanelEntry[]) => void;
  readonly onSecret: (secret: string, operation: "created" | "rotated") => void;
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
        options.onSecret(value.secret, "created");
        return await refreshEntries();
      });
    },
    async disable(id: string) {
      return await runExclusive(async () => {
        await request(`/${encodeURIComponent(id)}/disable`, { method: "POST" });
        return await refreshEntries();
      });
    },
    async enable(id: string) {
      return await runExclusive(async () => {
        await request(`/${encodeURIComponent(id)}/enable`, { method: "POST" });
        return await refreshEntries();
      });
    },
    async rotate(id: string) {
      return await runExclusive(async () => {
        const value = await request(`/${encodeURIComponent(id)}/rotate-secret`, { method: "POST" });
        if (!isRecord(value) || typeof value.secret !== "string" || !isRecord(value.webhook)) {
          throw new Error("The service returned an invalid webhook rotation result.");
        }
        options.onSecret(value.secret, "rotated");
        return await refreshEntries();
      });
    },
    async redeliver(id: string, eventId: string) {
      return await runExclusive(async () => {
        const value = await request(`/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(eventId)}/redeliver`, { method: "POST" });
        if (!isRecord(value) || (value.result !== "queued" && value.result !== "already_queued") || !isRecord(value.delivery)) {
          throw new Error("The service returned an invalid webhook redelivery result.");
        }
        await refreshEntries();
        return value.result;
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

const PUSH_BROWSER_ID_STORAGE_KEY = "0000:push-browser-id:v1";

export type PushEnrollmentState = {
  readonly message: string;
  readonly status: "denied" | "enrolled" | "error" | "not_configured" | "not_enrolled" | "permission_required" | "unsupported";
};

export interface PushSubscriptionLike {
  readonly endpoint: string;
  toJSON(): unknown;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { readonly applicationServerKey: ArrayBuffer; readonly userVisibleOnly: true }): Promise<PushSubscriptionLike>;
}

export interface PushRegistrationLike {
  readonly pushManager?: PushManagerLike;
  readonly scope?: string;
}

export interface PushEnrollmentControllerOptions {
  readonly endpoint: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly notifications?: { readonly permission: string; requestPermission(): Promise<string> };
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onState: (state: PushEnrollmentState) => void;
  readonly pushPublicKey?: string;
  readonly randomUUID?: () => string;
  readonly serviceWorker?: {
    readonly ready: Promise<PushRegistrationLike>;
    register(scriptUrl: string, options: { readonly scope: string }): Promise<PushRegistrationLike>;
  };
  readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

/** Room-scoped push enrollment. Browser-level PushSubscription lifetime is deliberately untouched. */
export function createPushEnrollmentController(options: PushEnrollmentControllerOptions) {
  let busy = false;
  let operationRevision = 0;
  let currentState: PushEnrollmentState = { status: "not_enrolled", message: "Browser alerts are off for this room." };
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const setState = (state: PushEnrollmentState) => { currentState = state; options.onState(state); return state; };
  const storageReadMessage = "Browser storage is unavailable, so this device's room enrollment could not be checked. Allow site storage and try again.";
  const storageWriteMessage = "Browser storage is unavailable, so this room was not enrolled and its private identity could not be saved. Allow site storage and try again.";

  function supportState(): PushEnrollmentState | undefined {
    if (!options.pushPublicKey) return { status: "not_configured", message: "Browser push is not configured on this service." };
    if (!options.serviceWorker || !options.notifications) {
      return { status: "unsupported", message: "This browser does not support the service worker and notification APIs required for push." };
    }
    return undefined;
  }

  function permissionState(): PushEnrollmentState | undefined {
    if (options.notifications?.permission === "denied") {
      return { status: "denied", message: "Notifications are blocked for this site. Change permission in your browser's site settings, then try again." };
    }
    if (options.notifications?.permission !== "granted") {
      return { status: "permission_required", message: "Choose Enable browser alerts to grant notification permission for this room." };
    }
    return undefined;
  }

  function readStoredBrowserId(): string | undefined {
    const value = options.storage.getItem(PUSH_BROWSER_ID_STORAGE_KEY);
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
      ? value.toLowerCase()
      : undefined;
  }

  function createBrowserId(): string {
    let current: string | null;
    try {
      current = options.storage.getItem(PUSH_BROWSER_ID_STORAGE_KEY);
    } catch {
      throw new Error(storageWriteMessage);
    }
    if (typeof current === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(current)) {
      return current.toLowerCase();
    }
    let browserId: string;
    try {
      browserId = options.randomUUID?.() ?? globalThis.crypto.randomUUID();
    } catch {
      throw new Error("This browser cannot create the private identity needed for room push enrollment.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(browserId)) {
      throw new Error("This browser could not create a valid private identity for room push enrollment.");
    }
    browserId = browserId.toLowerCase();
    try {
      options.storage.setItem(PUSH_BROWSER_ID_STORAGE_KEY, browserId);
      if (options.storage.getItem(PUSH_BROWSER_ID_STORAGE_KEY)?.toLowerCase() !== browserId) throw new Error("storage verification failed");
    } catch {
      throw new Error(storageWriteMessage);
    }
    return browserId;
  }

  function decodeApplicationServerKey(value: string): ArrayBuffer {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("The browser push key is invalid.");
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== 65 || bytes[0] !== 0x04) throw new Error("The browser push key is invalid.");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  function subscriptionJson(subscription: PushSubscriptionLike): { readonly endpoint: string; readonly expirationTime: null | number; readonly keys: { readonly auth: string; readonly p256dh: string } } {
    let value: unknown;
    try { value = subscription.toJSON(); } catch { throw new Error("The browser returned an invalid push subscription."); }
    if (!isRecord(value) || !isRecord(value.keys) || typeof subscription.endpoint !== "string"
      || typeof value.keys.auth !== "string" || typeof value.keys.p256dh !== "string") {
      throw new Error("The browser returned an invalid push subscription.");
    }
    const expirationTime = value.expirationTime === null || value.expirationTime === undefined
      ? null
      : typeof value.expirationTime === "number" && Number.isSafeInteger(value.expirationTime) && value.expirationTime >= 0
        ? value.expirationTime
        : undefined;
    if (expirationTime === undefined) throw new Error("The browser returned an invalid push subscription.");
    return { expirationTime, endpoint: subscription.endpoint, keys: { auth: value.keys.auth, p256dh: value.keys.p256dh } };
  }

  async function responseJson(response: Response): Promise<unknown> {
    let value: unknown;
    try { value = await response.json(); } catch { value = undefined; }
    if (!response.ok) {
      const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
        ? value.error.message
        : `The push request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    if (!isRecord(value)) throw new Error("The service returned an invalid browser push response.");
    return value;
  }

  async function roomRequest(method: "DELETE" | "GET" | "POST", browserId: string, subscription?: ReturnType<typeof subscriptionJson>): Promise<Record<string, unknown>> {
    const headers = new Headers({ accept: "application/json", "x-msg-browser-id": browserId });
    const init: RequestInit = { headers, method };
    if (subscription) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(subscription);
    }
    return await responseJson(await options.fetch(options.endpoint, init)) as Record<string, unknown>;
  }

  async function runExclusive(operation: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    operationRevision += 1;
    options.onBusyChange?.(true);
    try { await operation(); }
    finally { busy = false; options.onBusyChange?.(false); }
  }

  async function refresh(): Promise<PushEnrollmentState> {
    if (busy) return currentState;
    const revision = ++operationRevision;
    const commit = (state: PushEnrollmentState) => revision === operationRevision ? setState(state) : currentState;
    let browserId: string | undefined;
    try { browserId = readStoredBrowserId(); }
    catch { return commit({ status: "error", message: storageReadMessage }); }
    if (browserId) {
      try {
        const value = await roomRequest("GET", browserId);
        if (typeof value.enrolled !== "boolean") throw new Error("The service returned an invalid browser push status.");
        if (value.enrolled) {
          const blocked = options.notifications?.permission === "denied";
          return commit({
            status: "enrolled",
            message: blocked
              ? "This room is enrolled, but notifications are blocked. Change permission in your browser's site settings or turn off room alerts."
              : "Browser alerts are enabled for this room on this device.",
          });
        }
      } catch (error) {
        return commit({ status: "error", message: error instanceof Error ? error.message : "Could not check browser alerts for this room." });
      }
    }
    const support = supportState();
    if (support) return commit(support);
    return commit(permissionState() ?? { status: "not_enrolled", message: "Browser alerts are off for this room. Choose Enable browser alerts to turn them on." });
  }

  async function enroll(): Promise<void> {
    await runExclusive(async () => {
      const support = supportState();
      if (support) { setState(support); return; }
      let permission = options.notifications!.permission;
      if (permission === "default") {
        try { permission = await options.notifications!.requestPermission(); }
        catch { setState({ status: "error", message: "The browser could not request notification permission. Check this site's browser settings and try again." }); return; }
      }
      if (permission !== "granted") {
        setState(permission === "denied"
          ? { status: "denied", message: "Notifications are blocked for this site. Change permission in your browser's site settings, then try again." }
          : { status: "permission_required", message: "Notification permission was not granted. Choose Enable browser alerts to try again." });
        return;
      }
      let subscription: PushSubscriptionLike;
      try {
        const registration = await options.serviceWorker!.register("/_msg/push-service-worker.js", { scope: "/" });
        const activeRegistration = await options.serviceWorker!.ready;
        if (registration.scope && activeRegistration.scope && registration.scope !== activeRegistration.scope) {
          throw new Error("The active service worker does not match the room's browser notification scope.");
        }
        const pushManager = activeRegistration.pushManager;
        if (!pushManager) {
          setState({ status: "unsupported", message: "This browser does not provide a push manager for service workers." });
          return;
        }
        subscription = await pushManager.getSubscription() ?? await pushManager.subscribe({
          applicationServerKey: decodeApplicationServerKey(options.pushPublicKey!),
          userVisibleOnly: true,
        });
      } catch {
        setState({ status: "error", message: "The browser could not set up push for this device. Check notification settings and try again." });
        return;
      }
      let browserId: string;
      let body: ReturnType<typeof subscriptionJson>;
      try {
        body = subscriptionJson(subscription);
        browserId = createBrowserId();
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "The browser push subscription could not be saved." });
        return;
      }
      try {
        const value = await roomRequest("POST", browserId, body);
        if (value.enrolled !== true) throw new Error("The service did not confirm browser push enrollment.");
        setState({ status: "enrolled", message: "Browser alerts are enabled for this room on this device." });
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "Could not save browser alerts for this room." });
      }
    });
  }

  async function unsubscribe(): Promise<void> {
    await runExclusive(async () => {
      let browserId: string | undefined;
      try { browserId = readStoredBrowserId(); }
      catch { setState({ status: "error", message: storageReadMessage }); return; }
      if (!browserId) {
        setState({ status: "not_enrolled", message: "This browser has no saved room enrollment to remove." });
        return;
      }
      try {
        const value = await roomRequest("DELETE", browserId);
        if (typeof value.removed !== "boolean") throw new Error("The service returned an invalid browser push removal result.");
        setState({ status: "not_enrolled", message: value.removed
          ? "Browser alerts are off for this room. The shared browser subscription remains available to other rooms."
          : "This browser was not enrolled for this room." });
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "Could not turn off browser alerts for this room." });
      }
    });
  }

  return {
    enroll,
    refresh,
    sourceId: () => readPushBrowserId(options.storage),
    state: () => currentState,
    unsubscribe,
  };
}

/** Reads an existing origin-local browser identity without creating one for visitors who never enroll. */
export function readPushBrowserId(storage: { getItem(key: string): string | null }): string | undefined {
  try {
    const value = storage.getItem("0000:push-browser-id:v1");
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
      ? value.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

export interface OwnerPostingState {
  readonly busy: boolean;
  readonly enabled: boolean;
  readonly invitationAvailable: boolean;
  readonly message: string;
  readonly status: "disabled" | "enabled" | "error";
}

export interface OwnerControlsControllerOptions {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly manageUrl: string;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onState: (state: OwnerPostingState) => void;
  readonly openApiUrl: string;
  readonly publicRoomId: string;
  readonly publicRoomUrl: string;
}

/** Keeps the owner capability and delegated posting token in page memory only. */
export function createOwnerControlsController(options: OwnerControlsControllerOptions) {
  const publicRoom = new URL(options.publicRoomUrl);
  const management = new URL(options.manageUrl, publicRoom);
  if (management.origin !== publicRoom.origin || !/^\/manage\/[^/]+\/[^/]+$/u.test(management.pathname) || management.search || management.hash) {
    throw new Error("The service returned an invalid private owner link.");
  }
  let busy = false;
  let delegatedToken: string | undefined;
  let currentState: OwnerPostingState = {
    busy: false,
    enabled: false,
    invitationAvailable: false,
    message: "Agent posting is disabled.",
    status: "disabled",
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const setState = (state: OwnerPostingState) => {
    currentState = state;
    options.onState(state);
    return state;
  };
  const setBusy = (next: boolean) => {
    busy = next;
    options.onBusyChange?.(next);
  };

  function delegatedTokenFromUrl(value: unknown): string {
    if (typeof value !== "string") throw new Error("The service did not return an agent posting capability.");
    let parsed: URL;
    try { parsed = new URL(value, options.publicRoomUrl); } catch { throw new Error("The service returned an invalid agent posting capability."); }
    if (parsed.origin !== publicRoom.origin || parsed.pathname !== `${publicRoom.pathname}/post` || parsed.hash || [...parsed.searchParams.keys()].some((key) => key !== "token")) {
      throw new Error("The service returned an invalid agent posting capability.");
    }
    const values = parsed.searchParams.getAll("token");
    if (values.length !== 1 || !/^[A-Za-z0-9_-]+$/u.test(values[0] ?? "")) throw new Error("The service returned an invalid agent posting capability.");
    return values[0]!;
  }

  function invitation(): string {
    if (!delegatedToken) throw new Error("Enable agent posting before copying its invitation.");
    return [
      "Configure one GPT Action or connector for this 0000 conversation.",
      "",
      `Public room ID: ${options.publicRoomId}`,
      `Public room URL: ${options.publicRoomUrl}`,
      `OpenAPI import URL: ${options.openApiUrl}`,
      "",
      "Authentication: API key in the custom header X-0000-Post-Token",
      `Authentication value: ${delegatedToken}`,
      "",
      `POST endpoint: ${options.publicRoomUrl}/post`,
      "Use a unique Idempotency-Key header or client_message_id as the request ID for each new message; reuse it only when retrying that same message.",
      "",
      "Message to send:",
      "<write your message here>",
      "",
      "Anyone holding this posting capability can write to the conversation. Keep it secret and rotate or disable it from the owner link.",
    ].join("\n");
  }

  async function request(action: "disable" | "enable" | "rotate"): Promise<OwnerPostingState> {
    if (busy) return currentState;
    setBusy(true);
    setState({ ...currentState, busy: true, message: action === "disable" ? "Disabling agent posting…" : action === "rotate" ? "Rotating agent posting…" : "Enabling agent posting…" });
    try {
      const response = await options.fetch(options.manageUrl, {
        body: JSON.stringify({ action }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      let value: unknown;
      try { value = await response.json(); } catch { value = undefined; }
      if (!response.ok) {
        const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
          ? value.error.message
          : `The owner request failed with HTTP ${response.status}.`;
        throw new Error(message);
      }
      if (!isRecord(value) || typeof value.get_post_enabled !== "boolean") throw new Error("The service returned an invalid owner control response.");
      if (action === "disable" || value.get_post_enabled !== true) {
        delegatedToken = undefined;
        return setState({ busy: false, enabled: false, invitationAvailable: false, message: "Agent posting is disabled.", status: "disabled" });
      }
      delegatedToken = delegatedTokenFromUrl(value.get_post_url);
      return setState({ busy: false, enabled: true, invitationAvailable: true, message: action === "rotate" ? "Agent posting was rotated. Copy the new invitation for the agent." : "Agent posting is enabled. Copy the invitation for the agent.", status: "enabled" });
    } catch (error) {
      return setState({ ...currentState, busy: false, message: error instanceof Error ? error.message : "The owner control request failed.", status: "error" });
    } finally {
      setBusy(false);
      if (currentState.busy) setState({ ...currentState, busy: false });
    }
  }

  setState(currentState);
  return {
    copyInvitation: async (copy: (value: string) => Promise<void>): Promise<void> => {
      await copy(invitation());
    },
    disable: async () => await request("disable"),
    enable: async () => await request("enable"),
    invitation,
    rotate: async () => await request("rotate"),
    state: () => currentState,
  };
}
