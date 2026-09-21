import { validateConversationUrl } from "./wait.js";

const USAGE = "Usage: msg export <conversation-url> [--format json|markdown]";

export type ExportFormat = "json" | "markdown";

export interface ExportCommand {
  readonly conversationUrl: string;
  readonly format: ExportFormat;
}

export interface ExportOptions extends ExportCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stdoutBytes?: (chunk: Uint8Array) => Promise<void>;
}

export class ExportSignalError extends Error {
  constructor() { super("The msg export was interrupted."); }
}

export function parseExportCommand(args: readonly string[]): ExportCommand {
  if (args.length < 2 || args[0] !== "export") throw new Error(USAGE);
  let format: ExportFormat = "json";
  let seenFormat = false;
  for (let index = 2; index < args.length; index += 2) {
    if (args[index] !== "--format" || args[index + 1] === undefined || seenFormat) throw new Error(USAGE);
    const value = args[index + 1];
    if (value !== "json" && value !== "markdown") throw new Error(USAGE);
    format = value;
    seenFormat = true;
  }
  return { conversationUrl: validateConversationUrl(args[1] ?? ""), format };
}

export async function exportConversation(options: ExportOptions): Promise<void> {
  const conversationUrl = validateConversationUrl(options.conversationUrl);
  if (options.signal?.aborted) throw new ExportSignalError();
  const endpoint = new URL(conversationUrl);
  endpoint.pathname = `${endpoint.pathname}/export.${options.format === "json" ? "json" : "md"}`;
  let response: Response;
  try {
    response = await options.fetch(endpoint, {
      headers: { accept: options.format === "json" ? "application/json" : "text/markdown" },
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new ExportSignalError();
    throw error instanceof Error ? error : new Error("The msg export request failed.");
  }
  throwIfAborted(options.signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throwIfAborted(options.signal);
    throw new Error(`The msg service returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error("The msg service returned an empty export response.");
  const reader = response.body.getReader();
  const decoder = options.stdoutBytes === undefined ? new TextDecoder() : undefined;
  let rejectAbort: ((reason: ExportSignalError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const interrupted = () => {
    void reader.cancel().catch(() => {});
    rejectAbort?.(new ExportSignalError());
  };
  options.signal?.addEventListener("abort", interrupted, { once: true });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      throwIfAborted(options.signal);
      const output = options.stdoutBytes
        ? Promise.resolve().then(() => options.stdoutBytes!(next.value))
        : Promise.resolve().then(() => options.stdout(decoder!.decode(next.value, { stream: true })));
      await Promise.race([output, aborted]);
      throwIfAborted(options.signal);
    }
    if (decoder) options.stdout(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (options.signal?.aborted || error instanceof ExportSignalError || isAbortError(error)) throw new ExportSignalError();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", interrupted);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ExportSignalError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
