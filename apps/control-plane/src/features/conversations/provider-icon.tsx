import { CircleHelp } from "lucide-react";
import { siMessenger, siTelegram, siWhatsapp } from "simple-icons";
import type { Provider } from "@communicator/contracts";
import { cn } from "@/lib/utils";

type SimpleIconData = { path: string };

// simple-icons@16.28.0 omits LinkedIn, so this pinned local glyph is the deliberate fallback.
const linkedinIcon: SimpleIconData = {
  path: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 1 1 0-4.123 2.062 2.062 0 0 1 0 4.123zM6.119 20.452H2.56V9h3.559v11.452z",
};

const providerIcons: Partial<Record<Provider, SimpleIconData>> = {
  whatsapp: siWhatsapp,
  telegram: siTelegram,
  messenger: siMessenger,
  linkedin: linkedinIcon,
};

export function ProviderIcon({
  provider,
  className,
}: {
  provider: Provider | string;
  className?: string;
}) {
  const icon = providerIcons[provider as Provider];
  if (!icon) {
    return (
      <CircleHelp
        data-testid="provider-icon-fallback"
        aria-hidden="true"
        focusable="false"
        className={cn("size-4", className)}
      />
    );
  }

  return (
    <svg
      data-testid={`provider-icon-${provider}`}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-4", className)}
    >
      <path d={icon.path} />
    </svg>
  );
}
