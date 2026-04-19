"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

export function WalletButton() {
  const { connected, publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (connecting) {
    return (
      <button className="wallet-btn" disabled>
        Connecting…
      </button>
    );
  }

  if (connected && publicKey) {
    const addr = publicKey.toBase58();
    return (
      <button className="wallet-btn connected" onClick={() => void disconnect()}>
        {addr.slice(0, 4)}…{addr.slice(-4)}
      </button>
    );
  }

  return (
    <button className="wallet-btn" onClick={() => setVisible(true)}>
      Connect Wallet
    </button>
  );
}