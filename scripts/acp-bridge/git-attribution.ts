import { createHash } from "node:crypto";

export type BridgeCodeAttribution = {
  requestedByUserId?: string;
  provider?: "github";
  providerAccountId?: string;
  githubLogin?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  source?: "github-linked-account" | "0000-user";
};

export type GitAuthor = {
  email: string;
  name: string;
};

export function codeAttributionFromUnknown(
  value: unknown,
): BridgeCodeAttribution | undefined {
  const record = recordFromUnknown(value);
  if (!record) {
    return undefined;
  }
  const source =
    record.source === "github-linked-account" || record.source === "0000-user"
      ? record.source
      : undefined;
  if (!source) {
    return undefined;
  }
  return removeUndefinedValues({
    requestedByUserId: stringFromUnknown(record.requestedByUserId),
    provider: record.provider === "github" ? "github" : undefined,
    providerAccountId: stringFromUnknown(record.providerAccountId),
    githubLogin: stringFromUnknown(record.githubLogin),
    gitAuthorName: stringFromUnknown(record.gitAuthorName),
    gitAuthorEmail: stringFromUnknown(record.gitAuthorEmail),
    source,
  }) as BridgeCodeAttribution;
}

export function sanitizeGitAuthor(value: unknown): GitAuthor | undefined {
  const attribution = attributionFromUnknown(value);
  if (attribution?.source !== "github-linked-account") {
    return undefined;
  }
  const name = sanitizeGitAuthorField(attribution.gitAuthorName);
  const email = sanitizeGitAuthorField(attribution.gitAuthorEmail);
  if (!name || !email || !email.includes("@")) {
    return undefined;
  }
  return { email, name };
}

export function gitAuthorEnv(author: GitAuthor): Record<string, string> {
  return {
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_NAME: author.name,
  };
}

export function attributionSessionKeyPart(value: unknown): string | undefined {
  const author = sanitizeGitAuthor(value);
  if (!author) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(author.name)
    .update("\0")
    .update(author.email)
    .digest("hex")
    .slice(0, 16);
  return `git-author:${digest}`;
}

export function attributionPromptContext(value: unknown): string | undefined {
  const attribution = attributionFromUnknown(value);
  const author = sanitizeGitAuthor(value);
  if (!attribution || !author) {
    return undefined;
  }
  const login = sanitizeGithubLogin(attribution.githubLogin);
  const requester = login ? `GitHub @${login}` : "the linked GitHub account";
  return `0000 Chat attribution: this ACP run was requested by ${requester}. When creating git commits, preserve the configured git author identity.`;
}

function attributionFromUnknown(value: unknown): BridgeCodeAttribution | undefined {
  const record = recordFromUnknown(value);
  if (!record) {
    return undefined;
  }
  return codeAttributionFromUnknown(record.codeAttribution) ?? codeAttributionFromUnknown(record);
}

function sanitizeGitAuthorField(value: unknown): string | undefined {
  const text = stringFromUnknown(value);
  if (!text || text.length > 320 || /[\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  return text;
}

function sanitizeGithubLogin(value: unknown): string | undefined {
  const text = stringFromUnknown(value);
  return text && /^[A-Za-z0-9-]{1,39}$/.test(text) ? text : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeUndefinedValues(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}
