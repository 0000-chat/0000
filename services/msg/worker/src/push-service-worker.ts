/** Decrypted Web Push JSON; room_id is routing metadata, never the room capability. */
export interface MsgPushPayload {
  readonly type: "message.created";
  readonly room_id: string;
  readonly room_url: string;
}

export const PUSH_SERVICE_WORKER_PATH = "/_msg/push-service-worker.js";

const PUSH_SERVICE_WORKER_SCRIPT = String.raw`(() => {
  const notificationTitle = "New message in msg";
  const roomPathPattern = /^\/[A-Za-z0-9_-]{43}$/u;
  const roomIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
  const validViews = new Set(["agent", "human"]);

  function safeRoomUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;

    const parts = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?([^#]*))?$/iu.exec(value);
    if (!parts) return null;

    const path = parts[1] || "/";
    if (!roomPathPattern.test(path)) return null;

    let supplied;
    try {
      supplied = new URL(value);
    } catch {
      return null;
    }
    if (
      supplied.origin !== self.location.origin ||
      supplied.username !== "" ||
      supplied.password !== ""
    ) {
      return null;
    }

    const views = supplied.searchParams.getAll("view");
    const view = views.length === 1 && validViews.has(views[0]) ? views[0] : "human";
    const destination = new URL(path, self.location.origin);
    destination.searchParams.set("view", view);
    return destination;
  }

  function parsePushPayload(data) {
    let value;
    try {
      if (!data || typeof data.json !== "function") return null;
      value = data.json();
    } catch {
      return null;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (
      keys.length !== 3 ||
      keys.some((key) => !["type", "room_id", "room_url"].includes(key)) ||
      value.type !== "message.created" ||
      typeof value.room_id !== "string" ||
      !roomIdPattern.test(value.room_id)
    ) {
      return null;
    }

    const destination = safeRoomUrl(value.room_url);
    return destination ? { room_id: value.room_id, room_url: destination } : null;
  }

  function isMatchingRoomClient(client, destination) {
    try {
      const current = new URL(client.url);
      return current.origin === destination.origin &&
        current.username === "" &&
        current.password === "" &&
        current.pathname === destination.pathname &&
        roomPathPattern.test(current.pathname);
    } catch {
      return false;
    }
  }

  self.addEventListener("push", (event) => {
    const room = parsePushPayload(event.data);
    if (!room) return;

    event.waitUntil((async () => {
      let windowClients = [];
      try {
        windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      } catch {}
      if (windowClients.some((client) => client.focused === true && isMatchingRoomClient(client, room.room_url))) return;

      await self.registration.showNotification(notificationTitle, {
        data: { room_url: room.room_url.href },
        tag: "msg-room-" + room.room_id,
      });
    })());
  });

  self.addEventListener("notificationclick", (event) => {
    const notification = event.notification;
    if (notification && typeof notification.close === "function") notification.close();

    event.waitUntil((async () => {
      let roomUrl;
      try {
        roomUrl = safeRoomUrl(notification && notification.data && notification.data.room_url);
      } catch {
        return;
      }
      if (!roomUrl) return;

      const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windowClients) {
        if (!isMatchingRoomClient(client, roomUrl)) continue;

        try {
          await client.focus();
          return;
        } catch {
          continue;
        }
      }

      await self.clients.openWindow(roomUrl.href);
    })());
  });
})();`;

export function pushServiceWorkerResponse(): Response {
  return new Response(PUSH_SERVICE_WORKER_SCRIPT, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/javascript; charset=utf-8",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  });
}
