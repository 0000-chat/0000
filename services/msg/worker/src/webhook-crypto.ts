import { decryptOperationRecord, encryptOperationRecord } from "./operations-crypto";

const WEBHOOK_RECORD_TYPE = "webhook";

/** Uses the shared record envelope while binding data to this room and endpoint. */
export function encryptWebhookRecord(key: string, room: string, endpoint: string, kind: "headers" | "secret", value: unknown): Promise<string> {
  return encryptOperationRecord(key, WEBHOOK_RECORD_TYPE, `${room}/${endpoint}/${kind}`, value);
}

export function decryptWebhookRecord<T>(key: string, room: string, endpoint: string, kind: "headers" | "secret", value: string): Promise<T> {
  return decryptOperationRecord<T>(key, WEBHOOK_RECORD_TYPE, `${room}/${endpoint}/${kind}`, value);
}

export function isWebhookEnvelope(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && "v" in parsed
      && parsed.v === 1
      && "iv" in parsed
      && typeof parsed.iv === "string"
      && "ciphertext" in parsed
      && typeof parsed.ciphertext === "string";
  } catch {
    return false;
  }
}
