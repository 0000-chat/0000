import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { authSchema, createAuthPlugins } from "./auth-schema";

export function createAuth(env: Cloudflare.Env) {
  const schema = authSchema;
  return betterAuth({
    appName: "0000 Platform T01 probe",
    baseURL: env.PLATFORM_BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.PLATFORM_BASE_URL],
    database: drizzleAdapter(drizzle(env.IDENTITY_DB, { schema }), {
      provider: "sqlite",
      schema,
      camelCase: true,
      transaction: false,
    }),
    emailAndPassword: { enabled: false },
    account: {
      accountLinking: {
        disableImplicitLinking: true,
        allowUnlinkingAll: false,
      },
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    plugins: createAuthPlugins(),
  });
}

export type PlatformAuth = ReturnType<typeof createAuth>;
