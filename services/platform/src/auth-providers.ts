export const SOCIAL_PROVIDER_IDS = ["google", "github"] as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export interface SocialProviderEnvironment {
  GOOGLE_CLIENT_ID?: string | null;
  GOOGLE_CLIENT_SECRET?: string | null;
  GITHUB_CLIENT_ID?: string | null;
  GITHUB_CLIENT_SECRET?: string | null;
}

export type SocialProviderAvailability = Readonly<
  Record<SocialProviderId, boolean>
>;

export function configuredSocialProviders(
  env: SocialProviderEnvironment,
): SocialProviderAvailability {
  return {
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}
