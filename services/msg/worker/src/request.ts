import { ERROR_CODES, ProtocolError } from "./errors";
import type { JsonValue, Representation, RequestBody } from "./protocol";

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export interface ParseRequestBodyOptions {
  readonly maxBytes?: number;
}

export function negotiateRepresentation(accept: string | null): Representation {
  return (
    selectRepresentation(accept, [
      { representation: "html", mediaTypes: ["text/html"] },
      { representation: "json", mediaTypes: ["application/json"] },
      { representation: "markdown", mediaTypes: ["text/markdown", "text/plain"] },
    ]) ?? "markdown"
  );
}

export function negotiateCreateRepresentation(
  accept: string | null,
): Exclude<Representation, "html"> {
  return (
    selectRepresentation(accept, [
      { representation: "json", mediaTypes: ["application/json"] },
      { representation: "markdown", mediaTypes: ["text/plain"] },
    ]) ?? "json"
  );
}

export async function parseRequestBody(
  request: Request,
  options: ParseRequestBodyOptions = {},
): Promise<RequestBody> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const contentType = mediaType(request.headers.get("content-type"));

  if (
    contentType !== "" &&
    contentType !== "application/json" &&
    contentType !== "text/plain" &&
    contentType !== "application/x-www-form-urlencoded"
  ) {
    throw new ProtocolError(
      ERROR_CODES.unsupportedMediaType,
      "The request content type is not supported.",
      415,
    );
  }

  const body = await readUtf8Body(request, maxBytes);

  if (contentType === "application/json") {
    try {
      return { kind: "json", value: JSON.parse(body) as JsonValue };
    } catch {
      throw new ProtocolError(
        ERROR_CODES.invalidJson,
        "The request body is not valid JSON.",
        400,
      );
    }
  }

  return { kind: "raw", value: body };
}

function mediaType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

interface MediaRange {
  readonly quality: number;
  readonly subtype: string;
  readonly type: string;
}

interface RepresentationOption<T extends Representation> {
  readonly mediaTypes: readonly string[];
  readonly representation: T;
}

function selectRepresentation<T extends Representation>(
  accept: string | null,
  options: readonly RepresentationOption<T>[],
): T | undefined {
  const ranges = parseAccept(accept);
  let selected: T | undefined;
  let selectedQuality = -1;

  for (const option of options) {
    const quality = highestQuality(option.mediaTypes, ranges);
    if (quality > selectedQuality) {
      selected = option.representation;
      selectedQuality = quality;
    }
  }

  return selectedQuality > 0 ? selected : undefined;
}

function parseAccept(accept: string | null): MediaRange[] {
  if (!accept) return [];
  const ranges: MediaRange[] = [];

  for (const entry of accept.split(",")) {
    const [mediaType, ...parameters] = entry.split(";");
    const [type, subtype, ...rest] = mediaType.trim().toLowerCase().split("/");
    if (!type || !subtype || rest.length > 0) continue;

    const quality = parseQuality(parameters);
    if (quality === undefined) continue;
    ranges.push({ quality, subtype, type });
  }

  return ranges;
}

function parseQuality(parameters: readonly string[]): number | undefined {
  for (const parameter of parameters) {
    const [name, ...valueParts] = parameter.split("=");
    if (name.trim().toLowerCase() !== "q") continue;
    const value = valueParts.join("=").trim();
    if (!/^(?:0|1)(?:\.\d+)?$/.test(value)) return undefined;
    const quality = Number(value);
    return quality >= 0 && quality <= 1 ? quality : undefined;
  }
  return 1;
}

function highestQuality(
  mediaTypes: readonly string[],
  ranges: readonly MediaRange[],
): number {
  let highest = 0;
  for (const mediaType of mediaTypes) {
    const [type, subtype] = mediaType.split("/");
    highest = Math.max(highest, qualityForMediaType(type, subtype, ranges));
  }
  return highest;
}

function qualityForMediaType(
  type: string,
  subtype: string,
  ranges: readonly MediaRange[],
): number {
  let quality = 0;
  let specificity = -1;

  for (const range of ranges) {
    const matchSpecificity = mediaRangeSpecificity(range, type, subtype);
    if (matchSpecificity === -1) continue;
    if (matchSpecificity < specificity) continue;
    if (matchSpecificity > specificity) {
      specificity = matchSpecificity;
      quality = range.quality;
      continue;
    }
    quality = Math.max(quality, range.quality);
  }

  return quality;
}

function mediaRangeSpecificity(
  range: MediaRange,
  type: string,
  subtype: string,
): number {
  if (range.type === type && range.subtype === subtype) return 2;
  if (range.type === type && range.subtype === "*") return 1;
  if (range.type === "*" && range.subtype === "*") return 0;
  return -1;
}

async function readUtf8Body(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw bodyTooLarge();
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw bodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError(
      ERROR_CODES.invalidBody,
      "The request body is not valid UTF-8.",
      400,
    );
  }
}

function bodyTooLarge(): ProtocolError {
  return new ProtocolError(
    ERROR_CODES.bodyTooLarge,
    "The request body is too large.",
    413,
  );
}
