"use client";

import { useSwarmStore } from "@/stores/swarm.store";
import { WalletButton } from "./WalletButton";

export function Header() {
  const connected = useSwarmStore((s) => s.connected);
  const isHalted = useSwarmStore((s) => s.isHalted);

  return (
    <header className="header">
      <div className="logo">
        <div className="logo-icon" />
        <div>
          <div className="logo-text">
            <span>SWARM</span> CONDUCTOR
          </div>
          <div className="product-badges">
            <span className="product-badge conductor">Conductor</span>
            <span className="product-badge arena">Arena</span>
            <span className="product-badge veri">VeriAgent</span>
          </div>
        </div>
      </div>

      <div className="header-center">
        <div className="epoch-badge">SOLANA DEVNET</div>
        <div className="epoch-badge" id="epochBadge">EPOCH —</div>
      </div>

      <div className="header-right">
        <WalletButton />
        <div className={`conn-indicator${connected ? " connected" : ""}`}>
          {connected ? "● CONNECTED" : "● DISCONNECTED"}
        </div>
        <div className={`status-pill ${isHalted ? "halted" : "live"}`}>
          <div className="status-dot" />
          <span>{isHalted ? "HALTED" : "LIVE"}</span>
        </div>
      </div>
    </header>
  );
}