import { DurableObject } from "cloudflare:workers";
import { ERROR_CODES, ProtocolError } from "./errors";
import { CAPABILITY_PATTERN, GROUP_TTL_MS, invalidOrganization, MAX_CHAT_CONNECTIONS, organizationName, organizationObject } from "./organization-domain";

/** A group capability shares a collection. Room capabilities never expose this index. */
export class ChatGroup extends DurableObject<object> {
  constructor(ctx: DurableObjectState, env: object, private readonly now: () => number = Date.now) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS chat_group (id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_chats (room TEXT PRIMARY KEY, added_at INTEGER NOT NULL);`);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/initialize") {
        const name = organizationName(organizationObject(await request.json()).name);
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chat_group (id, name, expires_at) VALUES (1, ?, ?)", name, this.now() + GROUP_TTL_MS);
        await this.schedule();
        return Response.json(this.read());
      }
      this.read();
      if (request.method === "GET" && path === "/") return Response.json(this.read());
      if (request.method === "PATCH" && path === "/") {
        const name = organizationName(organizationObject(await request.json()).name);
        this.read();
        this.ctx.storage.sql.exec("UPDATE chat_group SET name = ?, expires_at = ? WHERE id = 1", name, this.now() + GROUP_TTL_MS);
      } else if ((request.method === "PUT" || request.method === "DELETE") && /^\/chats\/[A-Za-z0-9_-]{43}$/u.test(path)) {
        const room = path.slice(7);
        if (!CAPABILITY_PATTERN.test(room)) invalidOrganization("Invalid conversation.");
        this.ctx.storage.transactionSync(() => {
          this.read();
          if (request.method === "DELETE") this.ctx.storage.sql.exec("DELETE FROM group_chats WHERE room = ?", room);
          else {
            const exists = [...this.ctx.storage.sql.exec("SELECT room FROM group_chats WHERE room = ?", room)].length;
            const count = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM group_chats")][0].count;
            if (!exists && count >= MAX_CHAT_CONNECTIONS) throw new ProtocolError(ERROR_CODES.conflict, "A group can contain up to 50 conversations.", 409);
            this.ctx.storage.sql.exec("INSERT OR IGNORE INTO group_chats (room, added_at) VALUES (?, ?)", room, this.now());
          }
          this.ctx.storage.sql.exec("UPDATE chat_group SET expires_at = ? WHERE id = 1", this.now() + GROUP_TTL_MS);
        });
      } else throw new ProtocolError(ERROR_CODES.notFound, "Group route not found.", 404);
      await this.schedule();
      return Response.json(this.read());
    } catch (error) {
      if (error instanceof ProtocolError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
      return Response.json({ error: { code: ERROR_CODES.internal, message: "The group could not complete the request." } }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const state = [...this.ctx.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM chat_group WHERE id = 1")][0];
    if (state && state.expires_at > this.now()) { await this.schedule(); return; }
    // Keep a content-free expired marker so an old capability cannot be recreated.
    this.ctx.storage.sql.exec("DELETE FROM group_chats");
    this.ctx.storage.sql.exec("UPDATE chat_group SET name = '' WHERE id = 1");
    await this.ctx.storage.deleteAlarm();
  }

  private read(): { name: string; expires_at: string; rooms: string[] } {
    const state = [...this.ctx.storage.sql.exec<{ name: string; expires_at: number }>("SELECT name, expires_at FROM chat_group WHERE id = 1")][0];
    if (!state) throw new ProtocolError(ERROR_CODES.notFound, "Group not found.", 404);
    if (state.expires_at <= this.now()) {
      this.ctx.storage.sql.exec("DELETE FROM group_chats");
      this.ctx.storage.sql.exec("UPDATE chat_group SET name = '' WHERE id = 1");
      throw new ProtocolError(ERROR_CODES.gone, "This group has expired. Its conversations keep their own expiry dates.", 410);
    }
    const rooms = [...this.ctx.storage.sql.exec<{ room: string }>("SELECT room FROM group_chats ORDER BY added_at, rowid")].map(row => row.room);
    return { name: state.name, expires_at: new Date(state.expires_at).toISOString(), rooms };
  }

  private async schedule(): Promise<void> { await this.ctx.storage.setAlarm(Date.parse(this.read().expires_at)); }
}
