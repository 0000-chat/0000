export const queryKeys = {
  me: ["me"] as const,
  identities: ["identities"] as const,
  connections: (identityId: string) => ["connections", identityId] as const,
  channels: (identityId: string) => ["channels", identityId] as const,
  conversations: (identityId: string, channelId?: string) =>
    ["conversations", identityId, channelId ?? "all"] as const,
  conversation: (identityId: string, conversationId: string) =>
    ["conversation", identityId, conversationId] as const,
  messages: (identityId: string, conversationId: string) =>
    ["messages", identityId, conversationId] as const,
  commands: (identityId: string) => ["commands", identityId] as const,
  health: ["health"] as const,
};
