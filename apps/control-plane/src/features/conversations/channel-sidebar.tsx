import type { ChannelSummary } from "@communicator/contracts";
import { SortableChannelList } from "./sortable-channel-list";

export type ChannelSidebarProps = {
  channels: ChannelSummary[];
  identityId: string;
  selectedChannelId?: string;
  allUnreadCount: number;
  onSelect: (channelId?: string) => void;
  onReorder: (orderedIds: string[]) => void;
};

export function ChannelSidebar({
  channels,
  identityId,
  selectedChannelId,
  allUnreadCount,
  onSelect,
  onReorder,
}: ChannelSidebarProps) {
  return (
    <nav
      aria-label="Conversation channels"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div>
          <h2 className="text-sm font-semibold">Channels</h2>
          <p className="text-xs text-muted-foreground">Connected accounts</p>
        </div>
        <span className="text-xs text-muted-foreground">{channels.length}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SortableChannelList
          channels={channels}
          {...(selectedChannelId ? { selectedChannelId } : {})}
          allUnreadCount={allUnreadCount}
          onSelect={onSelect}
          onReorder={onReorder}
          manageConnectionHref={`/connections?identity=${encodeURIComponent(identityId)}`}
        />
      </div>
    </nav>
  );
}
