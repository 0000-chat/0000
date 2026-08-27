import { createFileRoute } from "@tanstack/react-router";
import { ConversationPage } from "@/features/conversations/conversation-page";

function ConversationRoute() {
  return <ConversationPage />;
}

export const Route = createFileRoute("/conversations/$conversationId")({ component: ConversationRoute });
