import { createFileRoute } from "@tanstack/react-router";
import { ConversationsShell } from "@/features/conversations/conversations-shell";

function ConversationRoute() {
  const { conversationId } = Route.useParams();
  return <ConversationsShell conversationId={conversationId} />;
}

export const Route = createFileRoute("/conversations/$conversationId")({ component: ConversationRoute });
