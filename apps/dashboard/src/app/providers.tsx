"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { useSwarmWebSocket } from "@/hooks/useSwarmWebSocket";
import "@solana/wallet-adapter-react-ui/styles.css";

function SwarmWebSocketMount({ children }: { children: React.ReactNode }) {
  useSwarmWebSocket();
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint =
    process.env["NEXT_PUBLIC_SOLANA_RPC_URL"] ?? clusterApiUrl(WalletAdapterNetwork.Testnet);

  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SwarmWebSocketMount>{children}</SwarmWebSocketMount>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
