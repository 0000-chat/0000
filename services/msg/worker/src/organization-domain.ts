import { ERROR_CODES, ProtocolError } from "./errors";

export const MAX_CHAT_CONNECTIONS = 50;
export const GROUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export interface ChatLink { readonly room: string; readonly kind: "related" | "source" | "branch"; readonly source_message: number | null; }
export interface ChatOverview { readonly title: string; readonly expires_at: string; readonly latest_message: number; }
export interface ListedChat extends Partial<ChatOverview> { readonly conversation_url: string; readonly title: string; readonly status: "active" | "unavailable" | "unknown"; }
export interface LinkedChat extends ListedChat { readonly kind: ChatLink["kind"]; readonly source_message: number | null; }
export interface GroupDocument { readonly name: string; readonly group_url: string; readonly expires_at: string; readonly chats: readonly ListedChat[]; }

export function invalidOrganization(message: string): never { throw new ProtocolError(ERROR_CODES.invalidBody, message, 400); }
export function organizationName(value: unknown, maximum = 80): string {
  // Reject control characters in user-visible single-line labels.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalidOrganization(`Use a name of 1–${maximum} characters on one line.`);
  return value.trim();
}
export function chatTitle(value: unknown, content: string): string {
  if (value !== undefined) return organizationName(value, 120);
  // eslint-disable-next-line no-control-regex
  return content.split(/\r?\n/u).find(line => line.trim())?.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120) || "Untitled conversation";
}
export function organizationObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidOrganization("A JSON object is required.");
  return value as Record<string, unknown>;
}
