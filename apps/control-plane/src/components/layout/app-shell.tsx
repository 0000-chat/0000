import { Menu } from "lucide-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  IdentityProvider,
  IdentitySwitcher,
} from "@/components/identity/identity-switcher";
import { cn } from "@/lib/utils";
import { EnvironmentBanner } from "./environment-banner";

const navigation = [
  { label: "Overview", to: "/" as const },
  { label: "Connections", to: "/connections" as const },
  { label: "Conversations", to: "/conversations" as const },
  { label: "Activity", to: "/activity" as const },
  { label: "Groups", to: "/groups" as const },
  { label: "System", to: "/system" as const },
];

function NavigationLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Primary navigation" className="grid gap-1">
      {navigation.map((item) => (
        <Link
          key={item.label}
          to={item.to}
          onClick={onNavigate}
          activeProps={{
            className: "bg-sidebar-accent text-sidebar-accent-foreground",
          }}
          className="rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const isConversationRoute = pathname.startsWith("/conversations");

  return (
    <IdentityProvider>
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <header className="sticky top-0 z-10 h-16 shrink-0 border-b bg-background/95 backdrop-blur">
          <div className="mx-auto flex h-full max-w-screen-2xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="xl:hidden"
                  aria-label="Open navigation"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 bg-sidebar">
                <SheetHeader className="text-left">
                  <SheetTitle>Communicator</SheetTitle>
                  <SheetDescription>Backoffice navigation</SheetDescription>
                </SheetHeader>
                <div className="mt-6">
                  <NavigationLinks />
                </div>
              </SheetContent>
            </Sheet>
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <Link to="/" className="text-lg font-semibold tracking-tight">
                Communicator
              </Link>
              <EnvironmentBanner />
            </div>
            <div className="ml-auto">
              <IdentitySwitcher />
            </div>
          </div>
        </header>
        <div
          className={cn(
            "grid min-h-0 w-full flex-1",
            isConversationRoute
              ? "xl:grid-cols-[15rem_minmax(0,1fr)]"
              : "mx-auto max-w-screen-2xl xl:grid-cols-[15rem_1fr]",
          )}
        >
          <aside
            className={cn(
              "hidden border-r bg-sidebar xl:block",
              isConversationRoute
                ? "min-h-0 overflow-y-auto p-4"
                : "min-h-[calc(100vh-4rem)] p-4",
            )}
          >
            <NavigationLinks />
          </aside>
          <main
            className={cn(
              "min-w-0",
              isConversationRoute
                ? "min-h-0 overflow-hidden p-0"
                : "p-4 sm:p-6 lg:p-8",
            )}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </IdentityProvider>
  );
}
