"use client";

import { useEffect, useRef } from "react";
import { useSwarmStore } from "../stores/swarm.store";

export function useSwarmWebSocket() {
  const { setConnected, applyMessage } = useSwarmStore();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<NodeJS.Timeout>();

  useEffect(() => {
    function connect() {
      const wsUrl = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:3001/ws";
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        clearTimeout(reconnectTimeout.current);
      };

      ws.onclose = () => {
        setConnected(false);
        // Reconnect after 3s
        reconnectTimeout.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        try {
          const { channel, payload } = JSON.parse(event.data as string) as {
            channel: string;
            payload: unknown;
          };
          applyMessage(channel, payload);
        } catch {
          // ignore malformed messages
        }
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout.current);
      wsRef.current?.close();
    };
  }, [setConnected, applyMessage]);

  return wsRef.current;
}
