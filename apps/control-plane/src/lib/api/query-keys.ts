export const queryKeys = {
  me: ["me"] as const,
  identities: ["identities"] as const,
  connections: (identityId: string) => ["connections", identityId] as const,
  conversations: (identityId: string) => ["conversations", identityId] as const,
  messages: (identityId: string, conversationId: string) =>
    ["messages", identityId, conversationId] as const,
  commands: (identityId: string) => ["commands", identityId] as const,
  health: ["health"] as const,
};
