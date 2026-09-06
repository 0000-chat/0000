import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ChannelSummary } from "@communicator/contracts";
import { GripVertical, Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./provider-icon";

export type SortableChannelListProps = {
  channels: ChannelSummary[];
  selectedChannelId?: string;
  allUnreadCount: number;
  onSelect: (channelId?: string) => void;
  onReorder: (orderedIds: string[]) => void;
  manageConnectionHref: string;
};

function statusLabel(channel: ChannelSummary) {
  if (channel.status === "attention_required") return "Attention required";
  if (channel.status === "disconnected") return "Disconnected";
  return null;
}

function ChannelStatus({ channel }: { channel: ChannelSummary }) {
  const label = statusLabel(channel);
  if (!label) return <span className="size-1.5 rounded-full bg-emerald-500" aria-label="Ready" />;

  return (
    <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

export function SortableChannelList({
  channels,
  selectedChannelId,
  allUnreadCount,
  onSelect,
  onReorder,
  manageConnectionHref,
}: SortableChannelListProps) {
  const connectedIds = channels.map((channel) => channel.id);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const announcements: Announcements = {
    onDragStart({ active }) {
      const channel = channels.find((item) => item.id === active.id);
      return channel
        ? `Picked up ${channel.display_label}. Use the arrow keys to move it, then press Space to drop.`
        : "Picked up channel.";
    },
    onDragOver({ active, over }) {
      if (!over || active.id === over.id) return;
      const channel = channels.find((item) => item.id === active.id);
      const destination = channels.find((item) => item.id === over.id);
      return channel && destination
        ? `${channel.display_label} is over ${destination.display_label}.`
        : undefined;
    },
    onDragEnd({ active, over }) {
      const channel = channels.find((item) => item.id === active.id);
      return channel && over
        ? `Dropped ${channel.display_label}.`
        : "Channel sorting cancelled.";
    },
    onDragCancel({ active }) {
      const channel = channels.find((item) => item.id === active.id);
      return channel ? `Cancelled sorting ${channel.display_label}.` : "Channel sorting cancelled.";
    },
  };

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const oldIndex = connectedIds.indexOf(String(active.id));
    const newIndex = connectedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(connectedIds, oldIndex, newIndex));
  }

  return (
    <>
      <p className="sr-only">
        Use Space to pick up a channel, arrow keys to move it, Space to drop it, and Escape to cancel.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements }}
        onDragEnd={handleDragEnd}
      >
        <ul aria-label="Channel list" className="divide-y divide-border/70">
          <li>
            <Button
              type="button"
              variant="ghost"
              className={cn(
                "h-auto min-h-11 w-full justify-start rounded-none px-4 py-2.5 text-left",
                !selectedChannelId && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              aria-label={`All, ${allUnreadCount} unread`}
              aria-current={!selectedChannelId ? "page" : undefined}
              onClick={() => onSelect(undefined)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Inbox className="size-4" aria-hidden="true" />
                </span>
                <span className="font-medium">All</span>
              </span>
              <Badge variant={!selectedChannelId ? "default" : "outline"}>{allUnreadCount}</Badge>
            </Button>
          </li>
          <SortableContext items={connectedIds} strategy={verticalListSortingStrategy}>
            {channels.map((channel) => (
              <SortableChannelRow
                key={channel.id}
                channel={channel}
                selected={selectedChannelId === channel.id}
                onSelect={onSelect}
                manageConnectionHref={manageConnectionHref}
              />
            ))}
          </SortableContext>
        </ul>
      </DndContext>
    </>
  );
}

function SortableChannelRow({
  channel,
  selected,
  onSelect,
  manageConnectionHref,
}: {
  channel: ChannelSummary;
  selected: boolean;
  onSelect: (channelId?: string) => void;
  manageConnectionHref: string;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channel.id,
  });
  const warning = statusLabel(channel);

  return (
    <li
      ref={setNodeRef}
      data-channel-id={channel.id}
      className={cn("relative bg-background", isDragging && "z-10 bg-accent/40 shadow-lg")}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <div className={cn("flex min-h-14 items-center gap-1.5 px-3 py-1.5", selected && "bg-sidebar-accent") }>
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start rounded-md px-1.5 py-1.5 text-left"
          aria-label={`Select ${channel.display_label}`}
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelect(channel.id)}
        >
          <ProviderIcon provider={channel.provider} className="size-4.5 shrink-0 text-primary" />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm font-medium">{channel.display_label}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs capitalize text-muted-foreground">{channel.provider}</span>
              <ChannelStatus channel={channel} />
            </span>
          </span>
          <Badge variant={selected ? "default" : "outline"}>{channel.unread_count}</Badge>
        </Button>
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          aria-label={`Reorder ${channel.display_label}`}
          data-testid={`channel-drag-handle-${channel.id}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      </div>
      {warning && (
        <a className="ml-12 block pb-2 text-xs text-primary underline underline-offset-2" href={manageConnectionHref}>
          Manage connection
        </a>
      )}
    </li>
  );
}
