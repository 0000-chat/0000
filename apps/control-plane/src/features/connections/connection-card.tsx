import { useState } from "react";
import type { Connection } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WhatsAppLinkSheet } from "./whatsapp-link-sheet";

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function providerLabel(provider: Connection["provider"]) {
  return provider === "whatsapp" ? "WhatsApp" : titleCase(provider);
}

export function ConnectionCard({
  connection,
  canManageLinking,
  actorDisplayName,
  identityDisplayName,
  onLinked,
}: {
  connection: Connection;
  canManageLinking: boolean;
  actorDisplayName: string;
  identityDisplayName: string;
  onLinked: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const isAttentionRequired = connection.status === "attention_required";
  const lastSynced = connection.last_synced_at
    ? new Date(connection.last_synced_at).toLocaleString("en-NZ", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Never";

  return (
    <article className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {providerLabel(connection.provider)}
          </p>
          <h2 className="mt-1 text-xl font-semibold">
            {connection.display_label}
          </h2>
        </div>
        <Badge variant={isAttentionRequired ? "destructive" : "secondary"}>
          {titleCase(connection.status)}
        </Badge>
      </div>

      {isAttentionRequired && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          <p className="font-semibold">Action required</p>
          <p className="mt-1">
            This simulated connection needs operator attention.
          </p>
        </div>
      )}

      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Provider</dt>
          <dd className="font-medium">{providerLabel(connection.provider)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last sync</dt>
          <dd className="font-medium">{lastSynced}</dd>
        </div>
      </dl>

      <details className="mt-5 rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Capabilities</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          {connection.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {capability}
            </Badge>
          ))}
        </div>
      </details>

      <div className="mt-5 flex flex-wrap gap-2">
        {canManageLinking && connection.provider === "whatsapp" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setLinkOpen(true)}
          >
            Link WhatsApp account
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled
            title="Linking is available to human administrators only"
            aria-label="Link WhatsApp account"
          >
            Link WhatsApp account
          </Button>
        )}
        {(["Reconnect", "Disconnect", "Unlink"] as const).map((label) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            disabled
            title={`Simulation only — ${label}`}
            aria-label={`Simulation only — ${label}`}
          >
            {label}
          </Button>
        ))}
      </div>
      <WhatsAppLinkSheet
        identityId={connection.identity_id}
        identityDisplayName={identityDisplayName}
        actorDisplayName={actorDisplayName}
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onLinked={onLinked}
      />
    </article>
  );
}
