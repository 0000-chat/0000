import { runtimeConfig } from "@/lib/config/runtime";

export function EnvironmentBanner() {
  const dataMode = runtimeConfig.dataMode;
  if (dataMode === "simulated") {
    return (
      <span
        className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold tracking-wide text-amber-950"
        role="status"
      >
        SIMULATED DATA — no provider actions are performed
      </span>
    );
  }

  return (
    <span className="rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-xs font-semibold tracking-wide text-emerald-950">
      LIVE DATA
    </span>
  );
}
