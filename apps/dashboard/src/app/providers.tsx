"use client";

import { useSwarmWebSocket } from "@/hooks/useSwarmWebSocket";

/**
 * Mounts the WebSocket connection once at the app root.
 * Must be a client component so it can call the hook.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useSwarmWebSocket();
  return <>{children}</>;
}
