import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getOAuthState } from "better-auth/api";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import {
  authSchema,
  createAuthPlugins,
  platformUserAdditionalFields,
} from "./auth-schema";
import {
  pendingSocialBindingFromSource,
  recoverPendingSocialAccount,
} from "./social-signup-recovery";

export const PLATFORM_SESSION_FRESH_AGE_SECONDS = 24 * 60 * 60;

export const disabledOrganizationPaths = [
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/set-active",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/leave",
  "/organization/list",
  "/organization/list-members",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/get-organization",
  "/organization/get-full-organization",
  "/organization/get-invitation",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/check-slug",
  "/organization/has-permission",
  "/organization/create-team",
  "/organization/remove-team",
  "/organization/update-team",
  "/organization/set-active-team",
  "/organization/list-teams",
  "/organization/list-user-teams",
  "/organization/list-team-members",
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/delete-user",
];

function requiresSignupInvitation(env: Cloudflare.Env): boolean {
  const deploymentMode: string = env.PLATFORM_DEPLOYMENT_MODE;
  const signupPolicy: string = env.PLATFORM_SIGNUP_POLICY;
  if (deploymentMode === "managed") return false;
  return deploymentMode !== "self-hosted" || signupPolicy !== "open";
}

async function requireCurrentInvitation(
  env: Cloudflare.Env,
  email: string,
): Promise<void> {
  const invitation = await env.IDENTITY_DB.withSession("first-primary")
    .prepare(
      `SELECT invitation.id
       FROM invitation
       JOIN organization ON organization.id = invitation.organizationId
       WHERE lower(invitation.email) = lower(?)
         AND invitation.status = 'pending'
         AND invitation.expiresAt > ?
         AND organization.suspendedAt IS NULL
       LIMIT 1`,
    )
    .bind(email, Date.now())
    .first<{ id: string }>();
  if (!invitation) {
    throw new APIError("FORBIDDEN", {
      code: "signup_invitation_required",
      message: "A current invitation for your verified email is required.",
    });
  }
}

async function hasActiveLinkSession(
  env: Cloudflare.Env,
  headers: Headers | undefined,
  expectedUserId: string,
): Promise<boolean> {
  if (!headers) return false;
  const current = await createAuth(env).api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!current || current.user.id !== expectedUserId) return false;
  const activeUser = await env.IDENTITY_DB.withSession("first-primary")
    .prepare('SELECT id FROM "user" WHERE id = ? AND disabledAt IS NULL')
    .bind(expectedUserId)
    .first<{ id: string }>();
  return activeUser !== null;
}

export function createAuth(env: Cloudflare.Env) {
  const schema = authSchema;
  let pendingSocialBinding: ReturnType<typeof pendingSocialBindingFromSource> =
    null;
  const recoverSocialProfile = async (
    providerId: "github" | "google",
    profile: object,
  ) => {
    const oauthState = await getOAuthState();
    if (oauthState?.link) return {};
    const binding = pendingSocialBindingFromSource(providerId, profile);
    if (!binding) return {};
    await recoverPendingSocialAccount(env.IDENTITY_DB, binding);
    return {};
  };
  return betterAuth({
    appName: "0000 Platform",
    baseURL: env.PLATFORM_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    disabledPaths: ["/unlink-account", ...disabledOrganizationPaths],
    trustedOrigins: [env.PLATFORM_BASE_URL],
    user: {
      additionalFields: platformUserAdditionalFields,
      validateUserInfo: async ({ user, source }, context) => {
        if (source.action === "create-user" && source.method === "oauth") {
          pendingSocialBinding = pendingSocialBindingFromSource(
            source.oauth?.providerId,
            source.oauth?.profile,
          );
          if (!pendingSocialBinding) {
            return {
              error: "social_identity_unavailable",
              errorDescription:
                "A verified provider subject is required for signup.",
            };
          }
        }
        if (source.action !== "link-account" || source.method !== "oauth") {
          return;
        }
        if (
          typeof user.id !== "string" ||
          !(await hasActiveLinkSession(env, context.headers, user.id))
        ) {
          return {
            error: "link_session_required",
            errorDescription:
              "Sign in again before linking a provider account.",
          };
        }
      },
    },
    session: { freshAge: PLATFORM_SESSION_FRESH_AGE_SECONDS },
    database: drizzleAdapter(drizzle(env.IDENTITY_DB, { schema }), {
      provider: "sqlite",
      schema,
      camelCase: true,
      transaction: false,
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const capturedSocialBinding = pendingSocialBinding;
            pendingSocialBinding = null;
            if (requiresSignupInvitation(env) && !user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "email_not_verified",
                message:
                  "Verify your provider email before signing in to Platform.",
              });
            }
            if (requiresSignupInvitation(env)) {
              await requireCurrentInvitation(env, user.email);
            }
            if (!capturedSocialBinding) return;
            return {
              data: {
                pendingSocialProviderId: capturedSocialBinding.providerId,
                pendingSocialSubject: capturedSocialBinding.subject,
              },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await env.IDENTITY_DB.withSession("first-primary")
              .prepare(
                'SELECT id FROM "user" WHERE id = ? AND disabledAt IS NULL',
              )
              .bind(session.userId)
              .first<{ id: string }>();
            if (!user) {
              throw new APIError("FORBIDDEN", {
                code: "user_disabled",
                message: "This Platform account is disabled.",
              });
            }
          },
        },
      },
    },
    emailAndPassword: { enabled: false },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
        trustedProviders: ["google", "github"],
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        mapProfileToUser: async (profile) =>
          recoverSocialProfile("google", profile),
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        mapProfileToUser: async (profile) =>
          recoverSocialProfile("github", profile),
      },
    },
    plugins: createAuthPlugins(),
  });
}

export type PlatformAuth = ReturnType<typeof createAuth>;
