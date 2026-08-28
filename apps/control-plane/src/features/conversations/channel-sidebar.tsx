import type { ChannelSummary } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { moveChannel } from "./channel-order";

export type ChannelSidebarProps = {
  channels: ChannelSummary[];
  identityId: string;
  selectedChannelId?: string;
  allUnreadCount: number;
  onSelect: (channelId?: string) => void;
  onReorder: (orderedIds: string[]) => void;
};

function statusLabel(channel: ChannelSummary) {
  if (channel.status === "attention_required") return "Attention required";
  if (channel.status === "disconnected") return "Disconnected";
  return null;
}

export function ChannelSidebar({
  channels,
  identityId,
  selectedChannelId,
  allUnreadCount,
  onSelect,
  onReorder,
}: ChannelSidebarProps) {
  const channelIds = channels.map((channel) => channel.id);
  const manageConnectionHref = `/connections?identity=${encodeURIComponent(identityId)}`;

  return (
    <nav aria-label="Conversation channels" className="flex min-h-full flex-col gap-2 p-3">
      <Button
        type="button"
        variant={!selectedChannelId ? "secondary" : "ghost"}
        className="justify-between"
        aria-current={!selectedChannelId ? "page" : undefined}
        onClick={() => onSelect(undefined)}
      >
        <span>All</span>
        <Badge variant="outline">{allUnreadCount}</Badge>
      </Button>
      <div className="grid gap-2">
        {channels.map((channel, index) => {
          const warning = statusLabel(channel);
          return (
            <div key={channel.id} data-channel-id={channel.id} className="rounded-lg border p-2">
              <Button
                type="button"
                variant={selectedChannelId === channel.id ? "secondary" : "ghost"}
                className="h-auto w-full justify-start px-2 py-2 text-left"
                aria-label={`Select ${channel.display_label}`}
                aria-current={selectedChannelId === channel.id ? "page" : undefined}
                onClick={() => onSelect(channel.id)}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{channel.provider}</span>
                  <span className="truncate">{channel.display_label}</span>
                  {warning && <span className="text-xs text-amber-700">{warning}</span>}
                </span>
                <Badge variant="outline">{channel.unread_count}</Badge>
              </Button>
              <div className="mt-2 flex items-center justify-between gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${channel.display_label} up`}
                  disabled={index === 0}
                  onClick={() => onReorder(moveChannel(channelIds, channel.id, -1))}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Move ${channel.display_label} down`}
                  disabled={index === channels.length - 1}
                  onClick={() => onReorder(moveChannel(channelIds, channel.id, 1))}
                >
                  ↓
                </Button>
              </div>
              {warning && (
                <a className="mt-1 block text-xs text-primary underline" href={manageConnectionHref}>
                  Manage connection
                </a>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
