import { ERROR_CODES, ProtocolError, type ErrorCode } from "./errors";
import { CAPABILITY_PATTERN, invalidOrganization, organizationName, organizationObject, type ChatLink, type ChatOverview, type GroupDocument, type LinkedChat, type ListedChat } from "./organization-domain";
import { randomCapability } from "./room-domain";
import type { RoomNamespace, RoomStub } from "./room-service";

export class OrganizationService {
  private readonly origin: string;
  constructor(private readonly rooms: RoomNamespace, private readonly groups: RoomNamespace, origin: string, private readonly connections: RoomNamespace) { this.origin = new URL(origin).origin; }

  async createGroup(value: unknown): Promise<GroupDocument> {
    const name = organizationName(organizationObject(value).name), group = randomCapability();
    await call(this.groups.getByName(group), "/initialize", "POST", { name });
    return this.readGroup(group);
  }
  async readGroup(group: string): Promise<GroupDocument> {
    const value = await call<{ name: string; expires_at: string; rooms: string[] }>(this.groups.getByName(group), "/");
    return { name: value.name, expires_at: value.expires_at, group_url: `${this.origin}/g/${group}`, chats: await Promise.all(value.rooms.map(room => this.listed(room))) };
  }
  async renameGroup(group: string, value: unknown): Promise<GroupDocument> {
    await call(this.groups.getByName(group), "/", "PATCH", { name: organizationName(organizationObject(value).name) });
    return this.readGroup(group);
  }
  async addToGroup(group: string, value: unknown): Promise<GroupDocument> {
    const room = this.roomFromUrl(organizationObject(value).conversation_url);
    await this.overview(room);
    await call(this.groups.getByName(group), `/chats/${room}`, "PUT");
    return this.readGroup(group);
  }
  async removeFromGroup(group: string, room: string): Promise<GroupDocument> {
    await call(this.groups.getByName(group), `/chats/${room}`, "DELETE");
    return this.readGroup(group);
  }
  async readLinks(room: string): Promise<{ links: LinkedChat[] }> {
    const value = await call<{ links: ChatLink[] }>(this.rooms.getByName(room), "/links");
    return { links: await Promise.all(value.links.map(async link => ({ ...await this.listed(link.room), kind: link.kind, source_message: link.source_message }))) };
  }
  async link(room: string, value: unknown): Promise<{ links: LinkedChat[] }> {
    const input = organizationObject(value), target = this.roomFromUrl(input.conversation_url);
    if (target === room) invalidOrganization("Choose a different conversation.");
    const source = input.source_message;
    if (source !== undefined && (!Number.isSafeInteger(source) || (source as number) < 1)) invalidOrganization("Choose an existing source message.");
    await call(this.connection(room, target), "/link", "POST", { room, target, ...(source === undefined ? {} : { source_message: source }) });
    return this.readLinks(room);
  }
  async unlink(room: string, target: string): Promise<{ links: LinkedChat[] }> {
    await call(this.connection(room, target), "/unlink", "POST", { room, target });
    return this.readLinks(room);
  }
  private connection(room: string, target: string): RoomStub {
    if (!CAPABILITY_PATTERN.test(room) || !CAPABILITY_PATTERN.test(target) || room === target) invalidOrganization("Choose two different conversations.");
    return this.connections.getByName([room, target].sort().join(":"));
  }
  private roomFromUrl(value: unknown): string {
    let url: URL;
    try { if (typeof value !== "string") throw new Error(); url = new URL(value); }
    catch { return invalidOrganization("Paste a full conversation link from this site."); }
    if (url.origin !== this.origin || url.username || url.password || url.search || url.hash || !CAPABILITY_PATTERN.test(url.pathname.slice(1))) invalidOrganization("Use a conversation link from this site, without query parameters, fragments or a management token.");
    return url.pathname.slice(1);
  }
  private overview(room: string): Promise<ChatOverview> { return call(this.rooms.getByName(room), "/overview"); }
  private async listed(room: string): Promise<ListedChat> {
    const conversation_url = `${this.origin}/${room}`;
    try { return { ...await this.overview(room), conversation_url, status: "active" }; }
    catch (error) {
      if (error instanceof ProtocolError && [404, 410].includes(error.status)) return { conversation_url, title: "Unavailable conversation", status: "unavailable" };
      return { conversation_url, title: "Conversation temporarily unavailable", status: "unknown" };
    }
  }
}

async function call<T>(stub: RoomStub, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await stub.fetch(new Request(`https://internal${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  const value = await response.json() as T & { error?: { code: ErrorCode; message: string } };
  if (!response.ok) throw new ProtocolError(value.error?.code ?? ERROR_CODES.serviceUnavailable, value.error?.message ?? "The connection could not be completed. Retry to finish both links.", response.status);
  return value;
}
