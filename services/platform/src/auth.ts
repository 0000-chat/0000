import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import {
  authSchema,
  createAuthPlugins,
  platformUserAdditionalFields,
} from "./auth-schema";

export const PLATFORM_SESSION_FRESH_AGE_SECONDS = 24 * 60 * 60;

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
  return betterAuth({
    appName: "0000 Platform",
    baseURL: env.PLATFORM_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    disabledPaths: ["/unlink-account"],
    trustedOrigins: [env.PLATFORM_BASE_URL],
    user: {
      additionalFields: platformUserAdditionalFields,
      validateUserInfo: async ({ user, source }, context) => {
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
            if (!requiresSignupInvitation(env)) return;
            if (!user.emailVerified) {
              throw new APIError("FORBIDDEN", {
                code: "email_not_verified",
                message:
                  "Verify your provider email before signing in to Platform.",
              });
            }
            await requireCurrentInvitation(env, user.email);
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
      },
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    plugins: createAuthPlugins(),
  });
}

export type PlatformAuth = ReturnType<typeof createAuth>;
