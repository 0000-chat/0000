export type SocialProviderId = "github" | "google";

export type PendingSocialBinding = {
  providerId: SocialProviderId;
  subject: string;
};

type SocialProfile = Record<string, unknown>;

function isRecord(value: unknown): value is SocialProfile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalGithubSubject(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

function canonicalGoogleSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.trim() !== value) return null;
  return value;
}

export function canonicalSocialSubject(
  providerId: string,
  profile: unknown,
): string | null {
  if (!isRecord(profile)) return null;
  if (providerId === "github") return canonicalGithubSubject(profile.id);
  if (providerId === "google") return canonicalGoogleSubject(profile.sub);
  return null;
}

export function pendingSocialBindingFromSource(
  providerId: string | undefined,
  profile: unknown,
): PendingSocialBinding | null {
  if (providerId !== "github" && providerId !== "google") return null;
  const subject = canonicalSocialSubject(providerId, profile);
  return subject ? { providerId, subject } : null;
}

export async function recoverPendingSocialAccount(
  database: D1Database,
  binding: PendingSocialBinding,
): Promise<void> {
  const now = Date.now();
  const accountId = crypto.randomUUID();
  await database
    .withSession("first-primary")
    .prepare(
      `INSERT INTO "account"
         ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
       SELECT ?, pendingSocialSubject, pendingSocialProviderId, "user"."id", ?, ?
       FROM "user"
       WHERE pendingSocialProviderId = ?
         AND pendingSocialSubject = ?
         AND disabledAt IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM "account" AS existing
           WHERE existing.providerId = ? AND existing.accountId = ?
         )
       LIMIT 1
       ON CONFLICT("providerId", "accountId") DO NOTHING`,
    )
    .bind(
      accountId,
      now,
      now,
      binding.providerId,
      binding.subject,
      binding.providerId,
      binding.subject,
    )
    .run();
}
