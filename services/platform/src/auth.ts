import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getOAuthState } from "better-auth/api";
import {
  betterAuth,
  type DBAdapter,
  type DBTransactionAdapter,
  type Where,
} from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import {
  authSchema,
  createAuthPlugins,
  platformUserAdditionalFields,
  type PlatformOAuthGrantTypes,
  type PlatformOAuthPostLogin,
  type PlatformOAuthScopes,
} from "./auth-schema";
import {
  pendingSocialBindingFromSource,
  recoverPendingSocialAccount,
} from "./social-signup-recovery";
import { emitPlatformDiagnostic } from "./diagnostics";

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

function scopedOAuthWhere(
  model: string,
  where: Where[] | undefined,
  installationId: string,
): Where[] | undefined {
  if (model !== "oauthAccessToken" && model !== "oauthRefreshToken") {
    return where;
  }
  return [
    ...(where ?? []),
    {
      field: "referenceId",
      operator: "eq",
      value: installationId,
      connector: "AND",
    },
  ];
}

function scopedFindMany(
  findMany: DBTransactionAdapter["findMany"],
  installationId: string,
): DBTransactionAdapter["findMany"] {
  return <T>(data: Parameters<DBTransactionAdapter["findMany"]>[0]) =>
    findMany<T>({
      ...data,
      where: scopedOAuthWhere(data.model, data.where, installationId),
    });
}

function scopedDeleteMany(
  deleteMany: DBTransactionAdapter["deleteMany"],
  installationId: string,
): DBTransactionAdapter["deleteMany"] {
  return (data) =>
    deleteMany({
      ...data,
      where: scopedOAuthWhere(data.model, data.where, installationId) ?? [],
    });
}

function scopedOAuthTransactionAdapter(
  adapter: DBTransactionAdapter,
  installationId: string,
): DBTransactionAdapter {
  return {
    ...adapter,
    findMany: scopedFindMany(adapter.findMany, installationId),
    deleteMany: scopedDeleteMany(adapter.deleteMany, installationId),
  };
}

function scopedOAuthAdapter(
  adapter: DBAdapter,
  installationId: string,
): DBAdapter {
  return {
    ...adapter,
    findMany: scopedFindMany(adapter.findMany, installationId),
    deleteMany: scopedDeleteMany(adapter.deleteMany, installationId),
    transaction: (callback) =>
      adapter.transaction((transaction) =>
        callback(scopedOAuthTransactionAdapter(transaction, installationId)),
      ),
  };
}

export class PlatformDatabaseUnavailableError extends Error {
  readonly code = "database_unavailable" as const;

  constructor() {
    super("Platform authority database unavailable.");
    this.name = "PlatformDatabaseUnavailableError";
  }
}

function safeDatabaseFailure(): PlatformDatabaseUnavailableError {
  return new PlatformDatabaseUnavailableError();
}

function rethrowSafeDatabaseFailure(error: unknown): never {
  if (error instanceof APIError) throw error;
  throw safeDatabaseFailure();
}

function safeAdapterCall<T extends (...args: any[]) => any>(
  call: T,
  onDatabaseFailure?: (oauthLink: boolean) => void,
): T {
  return (async (...args: any[]) => {
    try {
      return await call(...args);
    } catch (error) {
      if (!(error instanceof APIError)) {
        const oauthState = await getOAuthState().catch(() => null);
        onDatabaseFailure?.(Boolean(oauthState?.link));
      }
      rethrowSafeDatabaseFailure(error);
    }
  }) as T;
}

function safeTransactionAdapter(
  adapter: DBTransactionAdapter,
  onDatabaseFailure?: (oauthLink: boolean) => void,
): DBTransactionAdapter {
  return {
    ...adapter,
    create: safeAdapterCall(adapter.create, onDatabaseFailure),
    findOne: safeAdapterCall(adapter.findOne, onDatabaseFailure),
    findMany: safeAdapterCall(adapter.findMany, onDatabaseFailure),
    count: safeAdapterCall(adapter.count, onDatabaseFailure),
    update: safeAdapterCall(adapter.update, onDatabaseFailure),
    updateMany: safeAdapterCall(adapter.updateMany, onDatabaseFailure),
    delete: safeAdapterCall(adapter.delete, onDatabaseFailure),
    deleteMany: safeAdapterCall(adapter.deleteMany, onDatabaseFailure),
    consumeOne: safeAdapterCall(adapter.consumeOne, onDatabaseFailure),
    incrementOne: safeAdapterCall(adapter.incrementOne, onDatabaseFailure),
  };
}

function safeDatabaseAdapter(
  adapter: DBAdapter,
  onDatabaseFailure?: (oauthLink: boolean) => void,
): DBAdapter {
  return {
    ...adapter,
    create: safeAdapterCall(adapter.create, onDatabaseFailure),
    findOne: safeAdapterCall(adapter.findOne, onDatabaseFailure),
    findMany: safeAdapterCall(adapter.findMany, onDatabaseFailure),
    count: safeAdapterCall(adapter.count, onDatabaseFailure),
    update: safeAdapterCall(adapter.update, onDatabaseFailure),
    updateMany: safeAdapterCall(adapter.updateMany, onDatabaseFailure),
    delete: safeAdapterCall(adapter.delete, onDatabaseFailure),
    deleteMany: safeAdapterCall(adapter.deleteMany, onDatabaseFailure),
    consumeOne: safeAdapterCall(adapter.consumeOne, onDatabaseFailure),
    incrementOne: safeAdapterCall(adapter.incrementOne, onDatabaseFailure),
    ...(adapter.createSchema
      ? {
          createSchema: safeAdapterCall(
            adapter.createSchema,
            onDatabaseFailure,
          ),
        }
      : {}),
    transaction: async (callback) => {
      try {
        return await adapter.transaction((transaction) =>
          callback(safeTransactionAdapter(transaction, onDatabaseFailure)),
        );
      } catch (error) {
        if (!(error instanceof APIError)) {
          const oauthState = await getOAuthState().catch(() => null);
          onDatabaseFailure?.(Boolean(oauthState?.link));
        }
        rethrowSafeDatabaseFailure(error);
      }
    },
  };
}

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

export function createAuth(
  env: Cloudflare.Env,
  options: {
    oauthPlatform?: boolean;
    oauthPostLogin?: PlatformOAuthPostLogin;
    oauthGrantTypes?: PlatformOAuthGrantTypes;
    oauthScopes?: PlatformOAuthScopes;
    oauthRefreshInstallationId?: string;
    onDatabaseFailure?: (oauthLink: boolean) => void;
  } = {},
) {
  const schema = authSchema;
  const oauthRefreshInstallationId = options.oauthRefreshInstallationId;
  const databaseFactory = drizzleAdapter(drizzle(env.IDENTITY_DB, { schema }), {
    provider: "sqlite",
    schema,
    camelCase: true,
    transaction: false,
  });
  const databaseFactoryWithScope = oauthRefreshInstallationId
    ? (authOptions: Parameters<typeof databaseFactory>[0]) =>
        scopedOAuthAdapter(
          databaseFactory(authOptions),
          oauthRefreshInstallationId,
        )
    : databaseFactory;
  const database = (authOptions: Parameters<typeof databaseFactory>[0]) =>
    safeDatabaseAdapter(
      databaseFactoryWithScope(authOptions),
      options.onDatabaseFailure,
    );
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
    logger: {
      level: "error",
      // Better Auth passes raw provider, SQL and credential details as logger
      // arguments. Keep the supported logger hook, but publish only a fixed
      // allowlisted diagnostic event through Platform's single sink.
      log: () => {
        emitPlatformDiagnostic("platform.library.diagnostic", "error");
      },
    },
    onAPIError: {
      // APIError responses continue through Better Auth's normal protocol
      // conversion; unexpected errors propagate to Platform's fixed outer
      // unavailable response instead of the library logging their contents.
      throw: true,
      onError: () => {
        emitPlatformDiagnostic("platform.library.diagnostic", "error");
      },
    },
    database,
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
          after: async (user, context) => {
            emitPlatformDiagnostic(
              "platform.authentication.outcome",
              "success",
              {
                request: context?.request,
                principalId: user.id,
              },
            );
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
          after: async (session, context) => {
            emitPlatformDiagnostic("platform.session.signed_in", "success", {
              request: context?.request,
              principalId: session.userId,
              resourceId: session.id,
            });
          },
        },
        delete: {
          after: async (session, context) => {
            emitPlatformDiagnostic("platform.session.signed_out", "success", {
              request: context?.request,
              principalId: session.userId,
              resourceId: session.id,
            });
          },
        },
      },
      account: {
        create: {
          after: async (account, context) => {
            emitPlatformDiagnostic("platform.provider.linked", "success", {
              request: context?.request,
              principalId: account.userId,
              resourceId: account.id,
            });
          },
        },
        delete: {
          after: async (account, context) => {
            emitPlatformDiagnostic("platform.provider.unlinked", "success", {
              request: context?.request,
              principalId: account.userId,
              resourceId: account.id,
            });
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
    plugins: createAuthPlugins(
      options.oauthPlatform
        ? {
            resources: [],
            clientRegistrationDefaultResources: [],
            clientRegistrationAllowedResources: [],
            grantTypes: options.oauthGrantTypes ?? ["authorization_code"],
            scopes: options.oauthScopes ?? ["resource:read"],
            ...(options.oauthPostLogin
              ? { postLogin: options.oauthPostLogin }
              : {}),
          }
        : {},
    ),
  });
}

export type PlatformAuth = ReturnType<typeof createAuth>;
