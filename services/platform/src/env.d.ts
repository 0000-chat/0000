interface Env {
  /** Human OAuth is disabled until both the client ID and secret are configured. */
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    /** Human OAuth is disabled until both the client ID and secret are configured. */
    GOOGLE_CLIENT_SECRET: string;
    GITHUB_CLIENT_SECRET: string;
  }
}
