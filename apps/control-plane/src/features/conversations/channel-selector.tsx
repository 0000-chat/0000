import { cloneElement, isValidElement, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

export function ChannelSelector({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navigation = isValidElement<{
    onSelect?: (channelId?: string) => void;
  }>(children)
    ? cloneElement(children, {
        onSelect: (channelId?: string) => {
          children.props.onSelect?.(channelId);
          setOpen(false);
        },
      })
    : children;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start"
        >
          Channel: {label}
        </Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Channels</SheetTitle>
          <SheetDescription>
            Choose a connected account or view every conversation
          </SheetDescription>
        </SheetHeader>
        {navigation}
      </SheetContent>
    </Sheet>
  );
}
