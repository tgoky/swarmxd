/**
 * Structured logger — wraps pino for consistent JSON logs across all agents.
 * Each log entry includes the agent role for easy filtering.
 */

import pino from "pino";
import type { AgentRole } from "./types.js";

export interface LogContext {
  agentRole: AgentRole;
  agentId: string;
  [key: string]: unknown;
}

export function createLogger(context: LogContext) {
  const base = pino({
    level: process.env["LOG_LEVEL"] ?? "info",
    transport:
      process.env["NODE_ENV"] !== "production"
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  });

  return base.child(context);
}

export type Logger = ReturnType<typeof createLogger>;
