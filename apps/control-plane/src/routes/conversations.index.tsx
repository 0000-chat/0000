import { createFileRoute } from "@tanstack/react-router";

function ConversationsRoute() {
  return (
    <section className="space-y-3">
      <h1 className="text-3xl font-semibold tracking-tight">Conversations</h1>
      <p className="max-w-2xl text-muted-foreground">
        Browse conversations available to the selected identity.
      </p>
    </section>
  );
}

export const Route = createFileRoute("/conversations/")({ component: ConversationsRoute });
