"use client";

import { useSwarmStore } from "@/stores/swarm.store";
import { Header } from "./Header";
import { HaltBanner } from "./HaltBanner";
import { LeftPanel } from "./LeftPanel";
import { CenterPanel } from "./CenterPanel";
import { RightPanel } from "./RightPanel";

export function Dashboard() {
  const isHalted = useSwarmStore((s) => s.isHalted);

  return (
    <div className="app">
      <Header />
      {isHalted && <HaltBanner />}
      <main className="main">
        <LeftPanel />
        <CenterPanel />
        <RightPanel />
      </main>
    </div>
  );
}
