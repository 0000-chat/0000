import { runtimeConfig } from "@/lib/config/runtime";

export function EnvironmentBanner() {
  const dataMode = runtimeConfig.dataMode;
  if (dataMode === "simulated") {
    return (
      <span
        className="min-w-0 max-w-[5.5rem] truncate rounded-full border border-amber-300 bg-amber-100 px-2 py-1 text-[10px] font-semibold tracking-wide text-amber-950 sm:max-w-none sm:px-3 sm:text-xs"
        role="status"
      >
        <span className="block truncate whitespace-nowrap">
          SIMULATED DATA — no provider actions are performed
        </span>
      </span>
    );
  }

  return (
    <span className="rounded-full border border-emerald-300 bg-emerald-100 px-2 py-1 text-[10px] font-semibold tracking-wide text-emerald-950 sm:px-3 sm:text-xs">
      LIVE DATA
    </span>
  );
}
