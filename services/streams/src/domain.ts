export type TimelineEntry = { at: string; text: string };

export type StreamChoice = {
  id: string;
  label: string;
  value: string;
  recommended?: boolean;
};

export type VisibleStreamStatus = "needs_decision" | "ongoing" | "no_action";
export type LegacyStreamStatus = "active" | "deferred" | "archived";
export type StreamStatus = VisibleStreamStatus | LegacyStreamStatus;
export type DecisionKind = "decision" | "correction";
export type DecisionStatus = "pending" | "submitted" | "failed" | "rejected";

export type DecisionLock = {
  decisionId: string;
  choiceId: string;
  value: string;
  freeText: string;
  status: Exclude<DecisionStatus, "rejected">;
  kind: DecisionKind;
  correctionOf?: string;
  createdAt: string;
  attemptedAt: string;
  error?: string;
};

export type HelmStream = {
  streamId: string;
  title: string;
  about: string;
  timeline: TimelineEntry[];
  /** Legacy alias retained for older MCP clients and stored documents. */
  summary: string;
  /** Legacy alias retained for older MCP clients and stored documents. */
  history: string[];
  ownerBot: string;
  status: VisibleStreamStatus;
  needsDon: boolean;
  priority: number;
  choices: StreamChoice[];
  updatedAt: string;
  /** Archived streams remain hidden while their visible status is no_action. */
  archived?: boolean;
  decisionLock?: DecisionLock | null;
  /** Phase 2: per-stream choice webhook (head routine). Falls back to env CoS webhook when unset. */
  choiceWebhookUrl?: string;
  choiceWebhookAuthorization?: string;
};

export type StreamInput = {
  streamId: string;
  title: string;
  ownerBot: string;
  about?: string;
  timeline?: TimelineEntry[];
  summary?: string;
  history?: string[];
  status?: StreamStatus;
  needsDon?: boolean;
  priority?: number;
  choices?: StreamChoice[];
  updatedAt?: string;
  archived?: boolean;
  decisionLock?: DecisionLock | null;
  choiceWebhookUrl?: string;
  choiceWebhookAuthorization?: string;
};

export type StreamPatch = {
  streamId: string;
  status?: VisibleStreamStatus | LegacyStreamStatus;
  priority?: number;
};

const defaultChoices: StreamChoice[] = [
  { id: "send", label: "Send draft", value: "send_draft" },
  { id: "defer", label: "Defer", value: "defer" },
  { id: "delegate", label: "Delegate", value: "delegate" },
  { id: "mute", label: "Mute", value: "mute" },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeTimelineEntries(
  value: unknown,
  name: string,
): TimelineEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.at !== "string" ||
      typeof entry.text !== "string"
    ) {
      throw new Error(`${name}[${index}] must contain at and text strings`);
    }
    if (!entry.at.trim()) throw new Error(`${name}[${index}].at is required`);
    if (!entry.text.trim())
      throw new Error(`${name}[${index}].text is required`);
    return { at: entry.at, text: entry.text };
  });
}

function normalizeHistory(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("history must contain strings");
  }
  return value;
}

function timelineKey(entry: TimelineEntry): string {
  return `${entry.at}\u0000${entry.text}`;
}

/** Append entries while preserving order and exact (at,text) duplicates. */
export function appendTimeline(
  existing: TimelineEntry[],
  incoming: TimelineEntry[],
): TimelineEntry[] {
  const result = existing.map((entry) => ({ at: entry.at, text: entry.text }));
  const seen = new Set(result.map(timelineKey));
  for (const entry of incoming) {
    const copy = { at: entry.at, text: entry.text };
    const key = timelineKey(copy);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(copy);
  }
  return result;
}

function visibleStatus(input: StreamInput): {
  status: VisibleStreamStatus;
  needsDon: boolean;
  archived: boolean;
} {
  const archived = input.archived === true || input.status === "archived";
  if (archived) return { status: "no_action", needsDon: false, archived: true };
  if (input.status === "deferred" || input.status === "no_action") {
    return { status: "no_action", needsDon: false, archived };
  }
  if (input.status === "needs_decision")
    return { status: "needs_decision", needsDon: true, archived };
  if (input.status === "ongoing")
    return { status: "ongoing", needsDon: false, archived };
  if (input.status === "active") {
    return input.needsDon === false
      ? { status: "ongoing", needsDon: false, archived }
      : { status: "needs_decision", needsDon: true, archived };
  }
  if (input.needsDon === true || input.needsDon === undefined) {
    return { status: "needs_decision", needsDon: true, archived };
  }
  return { status: "ongoing", needsDon: false, archived };
}

function normalizeChoices(value: unknown): StreamChoice[] {
  const choices = value === undefined ? defaultChoices : value;
  if (!Array.isArray(choices) || choices.length === 0)
    throw new Error("at least one choice is required");
  const normalized = choices.map((choice, index) => {
    if (!isRecord(choice))
      throw new Error(`choice[${index}] must be an object`);
    for (const field of ["id", "label", "value"]) {
      if (typeof choice[field] !== "string" || !choice[field].trim())
        throw new Error(`choice.${field} is required`);
    }
    if (
      choice.recommended !== undefined &&
      typeof choice.recommended !== "boolean"
    ) {
      throw new Error("choice.recommended must be boolean");
    }
    return {
      id: choice.id as string,
      label: choice.label as string,
      value: choice.value as string,
      ...(choice.recommended === true ? { recommended: true } : {}),
    };
  });
  if (normalized.filter((choice) => choice.recommended === true).length > 1) {
    throw new Error("at most one choice may be recommended");
  }
  return normalized;
}

function normalizeDecisionLock(value: unknown): DecisionLock | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("decisionLock must be an object");
  if (typeof value.decisionId !== "string" || !value.decisionId)
    throw new Error("decisionLock.decisionId is required");
  if (typeof value.choiceId !== "string" || !value.choiceId)
    throw new Error("decisionLock.choiceId is required");
  if (typeof value.value !== "string")
    throw new Error("decisionLock.value is required");
  if (typeof value.freeText !== "string")
    throw new Error("decisionLock.freeText is required");
  if (
    value.status !== "pending" &&
    value.status !== "submitted" &&
    value.status !== "failed"
  ) {
    throw new Error("decisionLock.status is invalid");
  }
  if (value.kind !== "decision" && value.kind !== "correction")
    throw new Error("decisionLock.kind is invalid");
  if (typeof value.createdAt !== "string" || !value.createdAt)
    throw new Error("decisionLock.createdAt is required");
  if (typeof value.attemptedAt !== "string" || !value.attemptedAt)
    throw new Error("decisionLock.attemptedAt is required");
  if (
    value.correctionOf !== undefined &&
    typeof value.correctionOf !== "string"
  )
    throw new Error("decisionLock.correctionOf is invalid");
  if (value.error !== undefined && typeof value.error !== "string")
    throw new Error("decisionLock.error is invalid");
  if (
    value.kind === "correction" &&
    (typeof value.correctionOf !== "string" || !value.correctionOf)
  ) {
    throw new Error("correction decision requires correctionOf");
  }
  if (value.kind === "decision" && value.correctionOf !== undefined) {
    throw new Error("decision cannot have correctionOf");
  }
  return {
    decisionId: value.decisionId,
    choiceId: value.choiceId,
    value: value.value,
    freeText: value.freeText,
    status: value.status,
    kind: value.kind,
    ...(typeof value.correctionOf === "string"
      ? { correctionOf: value.correctionOf }
      : {}),
    createdAt: value.createdAt,
    attemptedAt: value.attemptedAt,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/**
 * Normalize both the current document shape and the legacy summary/history
 * shape. Legacy history strings use the stored updatedAt as their timestamp.
 */
export function normalizeStream(
  input: StreamInput,
  now = new Date(),
): HelmStream {
  if (typeof input.streamId !== "string" || !input.streamId.trim())
    throw new Error("streamId is required");
  if (typeof input.title !== "string" || !input.title.trim())
    throw new Error("title is required");
  if (typeof input.ownerBot !== "string" || !input.ownerBot.trim())
    throw new Error("ownerBot is required");

  const updatedAt = input.updatedAt ?? now.toISOString();
  if (typeof updatedAt !== "string" || !updatedAt.trim())
    throw new Error("updatedAt is required");
  if (input.about !== undefined && typeof input.about !== "string")
    throw new Error("about must be a string");
  if (input.summary !== undefined && typeof input.summary !== "string")
    throw new Error("summary must be a string");
  // about and summary may diverge. Legacy: missing about falls back to summary;
  // missing summary falls back to about (display/ops that only read one field).
  const about = input.about ?? input.summary ?? "";
  const summary = input.summary ?? input.about ?? "";
  const timeline = appendTimeline(
    [],
    normalizeTimelineEntries(input.timeline, "timeline"),
  );
  const history = normalizeHistory(input.history);
  const legacyEntries = history.map((text) => ({ at: updatedAt, text }));
  const normalizedTimeline = appendTimeline(timeline, legacyEntries);
  const status = visibleStatus(input);

  return {
    streamId: input.streamId,
    title: input.title,
    about,
    timeline: normalizedTimeline,
    summary,
    history: normalizedTimeline.map((entry) => entry.text),
    ownerBot: input.ownerBot,
    status: status.status,
    needsDon: status.needsDon,
    priority: normalizePriority(input.priority),
    choices: normalizeChoices(input.choices),
    updatedAt,
    ...(status.archived ? { archived: true } : {}),
    decisionLock: normalizeDecisionLock(input.decisionLock),
    ...(typeof input.choiceWebhookUrl === "string" &&
    input.choiceWebhookUrl.trim()
      ? { choiceWebhookUrl: input.choiceWebhookUrl.trim() }
      : {}),
    ...(typeof input.choiceWebhookAuthorization === "string" &&
    input.choiceWebhookAuthorization.trim()
      ? { choiceWebhookAuthorization: input.choiceWebhookAuthorization.trim() }
      : {}),
  };
}

function normalizePriority(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("priority must be a nonnegative integer");
  }
  return value;
}

function statusRank(stream: HelmStream): number {
  if (stream.archived) return 2;
  if (stream.status === "needs_decision" || stream.needsDon) return 0;
  if (stream.status === "ongoing") return 1;
  return 2;
}

export function sortStreams(streams: HelmStream[]): HelmStream[] {
  return [...streams].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      b.priority - a.priority ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.streamId.localeCompare(b.streamId),
  );
}

export function groupStreams(streams: HelmStream[]): {
  needsYou: HelmStream[];
  elsewhere: HelmStream[];
} {
  const visible = streams.filter((stream) => !stream.archived);
  return {
    needsYou: sortStreams(
      visible.filter(
        (stream) => stream.status === "needs_decision" || stream.needsDon,
      ),
    ),
    elsewhere: sortStreams(
      visible.filter(
        (stream) => stream.status !== "needs_decision" && !stream.needsDon,
      ),
    ),
  };
}

export function validateDecision(
  stream: HelmStream,
  input: { choiceId: string; value: string; freeText: string },
): void {
  const status = stream.status as string;
  if (stream.archived || (status !== "needs_decision" && status !== "active")) {
    throw new Error("stream is not active");
  }
  if (
    input.choiceId === "custom" &&
    input.value === "custom" &&
    input.freeText.trim()
  )
    return;
  if (
    !stream.choices.some(
      (choice) => choice.id === input.choiceId && choice.value === input.value,
    )
  ) {
    throw new Error("choice does not match the stream");
  }
}

function manilaTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

export type WebhookDecision = {
  streamId: string;
  choiceId: string;
  value: string;
  freeText: string;
  decisionId: string;
  kind?: DecisionKind;
  correctionOf?: string;
  createdAt?: string;
  now?: Date;
};

export function buildWebhookPayload(input: WebhookDecision) {
  const timestamp = input.createdAt
    ? new Date(input.createdAt)
    : (input.now ?? new Date());
  if (Number.isNaN(timestamp.getTime()))
    throw new Error("decision timestamp is invalid");
  const kind = input.kind ?? "decision";
  if (
    kind === "correction" &&
    (!input.correctionOf || input.correctionOf === input.decisionId)
  ) {
    throw new Error("correction decision requires correctionOf");
  }
  if (kind === "decision" && input.correctionOf !== undefined) {
    throw new Error("decision cannot have correctionOf");
  }
  return {
    stream_id: input.streamId,
    choice_id: input.choiceId,
    value: input.value,
    free_text: input.freeText,
    timestamp_manila: manilaTimestamp(timestamp),
    decision_id: input.decisionId,
    kind,
    ...(kind === "correction" ? { correctionOf: input.correctionOf } : {}),
  };
}
