export const PRODUCTION_ORIGIN = "https://msg.0000.chat";
export const LOCAL_CLI = "node services/msg/cli/dist/cli.js";
export function allowedOrigin(url: URL): boolean {
  return url.origin === PRODUCTION_ORIGIN || (["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
export function validateOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw Error("Use the msg production origin or a localhost preview origin."); }
  if (!allowedOrigin(url) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("Use the msg production origin or a localhost preview origin, without credentials or a path.");
  return url.origin;
}
export function validateChatUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw Error("The conversation URL must be https://msg.0000.chat/{room}."); }
  if (!allowedOrigin(url) || url.username || url.password || url.search || url.hash || !/^\/[^/]+$/u.test(url.pathname)) throw Error("The conversation URL must be https://msg.0000.chat/{room}. Localhost preview URLs are also supported.");
  return url.toString();
}
export function validateGroupUrl(value: string): string {
  const url = new URL(value);
  if (!allowedOrigin(url) || url.username || url.password || url.search || url.hash || !/^\/g\/[A-Za-z0-9_-]{43}$/u.test(url.pathname)) throw Error("Use a canonical msg group URL: <origin>/g/<group>.");
  return url.toString();
}
export function sameOrigin(a: string, b: string): void {
  if (new URL(a).origin !== new URL(b).origin) throw Error("Both URLs must belong to the same msg origin.");
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
export function cliPrefix(url: string): string { return new URL(url).origin === PRODUCTION_ORIGIN ? "npx --yes @0000chat/msg@latest" : LOCAL_CLI; }
