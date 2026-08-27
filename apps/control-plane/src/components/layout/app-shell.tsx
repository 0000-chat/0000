import { Menu } from "lucide-react";
import { Link, Outlet } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { IdentityProvider, IdentitySwitcher } from "@/components/identity/identity-switcher";
import { EnvironmentBanner } from "./environment-banner";

const navigation = [
  { label: "Overview", to: "/" as const },
  { label: "Connections", to: "/connections" as const },
  { label: "Conversations", to: "/conversations" as const },
  { label: "Activity", to: "/activity" as const },
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
  return (
    <IdentityProvider>
      <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-screen-2xl items-center gap-4 px-4 sm:px-6">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="lg:hidden" aria-label="Open navigation">
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
          <div className="flex min-w-0 items-center gap-3">
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
      <div className="mx-auto grid max-w-screen-2xl lg:grid-cols-[15rem_1fr]">
        <aside className="hidden min-h-[calc(100vh-4rem)] border-r bg-sidebar p-4 lg:block">
          <NavigationLinks />
        </aside>
        <main className="min-w-0 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
      </div>
    </IdentityProvider>
  );
}
