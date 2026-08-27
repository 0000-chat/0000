import { useState } from "react";

export function IdentitySwitcher() {
  const [identity, setIdentity] = useState("identity_human");

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="active-identity" className="text-sm font-medium">
        Active identity
      </label>
      <select
        id="active-identity"
        value={identity}
        onChange={(event) => setIdentity(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="identity_human">Human</option>
        <option value="identity_agent">Agent</option>
      </select>
    </div>
  );
}
