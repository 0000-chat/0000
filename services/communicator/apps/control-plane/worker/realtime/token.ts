const REALTIME_TICKET_BYTE_LENGTH = 32;
const REALTIME_TICKET_PREFIX = "rt1_";
const REALTIME_TICKET_PATTERN = /^rt1_[A-Za-z0-9_-]{43}$/;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

export const isRealtimeTicket = (value: unknown): value is string =>
  typeof value === "string" && REALTIME_TICKET_PATTERN.test(value);

export function generateRealtimeTicket(
  randomValues: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
): string {
  const bytes = new Uint8Array(32);
  const filled = randomValues(bytes);
  if (
    !(filled instanceof Uint8Array) ||
    filled.byteLength !== REALTIME_TICKET_BYTE_LENGTH
  ) {
    throw new Error("Realtime ticket randomness has an invalid length");
  }

  return `${REALTIME_TICKET_PREFIX}${base64UrlEncode(new Uint8Array(filled))}`;
}

export async function digestRealtimeTicket(ticket: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ticket),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
