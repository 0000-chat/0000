export const SOCIAL_PROVIDER_IDS = ["google", "github"] as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export interface SocialProviderEnvironment {
  GOOGLE_CLIENT_ID?: string | null;
  GOOGLE_CLIENT_SECRET?: string | null;
  GITHUB_CLIENT_ID?: string | null;
  GITHUB_CLIENT_SECRET?: string | null;
}

export interface SocialProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export type SocialProviderConfiguration = Readonly<
  Partial<Record<SocialProviderId, SocialProviderCredentials>>
>;

export type SocialProviderAvailability = Readonly<
  Record<SocialProviderId, boolean>
>;

function providerCredentials(
  clientId: string | null | undefined,
  clientSecret: string | null | undefined,
): SocialProviderCredentials | undefined {
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

export function configuredSocialProviders(
  env: SocialProviderEnvironment,
): SocialProviderConfiguration {
  const google = providerCredentials(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
  );
  const github = providerCredentials(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
  );
  return {
    ...(google ? { google } : {}),
    ...(github ? { github } : {}),
  };
}

export function socialProviderAvailability(
  configuration: SocialProviderConfiguration,
): SocialProviderAvailability {
  return {
    google: Boolean(configuration.google),
    github: Boolean(configuration.github),
  };
}

export function configuredSocialProviderAvailability(
  env: SocialProviderEnvironment,
): SocialProviderAvailability {
  return socialProviderAvailability(configuredSocialProviders(env));
}
