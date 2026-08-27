import { createFileRoute } from "@tanstack/react-router";

function ConversationRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">Conversation</h1>
      <p className="max-w-2xl text-muted-foreground">
        Open a conversation to review its timeline.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/conversations/$conversationId")({ component: ConversationRoute });
