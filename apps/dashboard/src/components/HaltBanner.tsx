"use client";

import { useSwarmStore } from "@/stores/swarm.store";

export function HaltBanner() {
  const haltReason = useSwarmStore((s) => s.haltReason);

  return (
    <div className="halt-banner">
      🚨 SWARM HALTED — <span>{haltReason ?? "Unknown reason"}</span>
    </div>
  );
}
