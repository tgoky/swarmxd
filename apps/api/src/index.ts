/**
 * Swarm Conductor API Server
 *
 * REST + WebSocket endpoints for the dashboard and external integrations.
 * WebSocket broadcasts all swarm events in real-time.
 *
 * Routes:
 *   GET  /health                    — liveness probe
 *   GET  /api/v1/state              — full swarm state snapshot
 *   GET  /api/v1/portfolio          — portfolio with positions + PnL
 *   GET  /api/v1/signals            — active signals
 *   GET  /api/v1/proposals          — pending proposals + votes
 *   GET  /api/v1/executions         — recent execution history
 *   GET  /api/v1/memory             — on-chain decision log
 *   POST /api/v1/halt               — emergency halt (authenticated)
 *   POST /api/v1/resume             — resume after halt (authenticated)
 *   WS   /ws                        — real-time event stream
 */

import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import helmet from "helmet";
import { createClient } from "redis";
import { nanoid } from "nanoid";
import { CHANNELS } from "@swarm/shared";
import type { BusMessage } from "@swarm/shared";

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (process.env["CORS_ORIGINS"] ?? "http://localhost:3000").split(","),
  credentials: true,
}));
app.use(express.json());

// Request ID middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { id: string }).id = nanoid(8);
  next();
});

// ── Redis sub for broadcasting to WS clients ──────────────────────────────────

const redisSub = createClient({ url: process.env["REDIS_URL"] ?? "redis://localhost:6379" });

const wsClients = new Set<WebSocket>();

function broadcast(channel: string, payload: unknown): void {
  const message = JSON.stringify({ channel, payload, timestamp: new Date() });
  wsClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ── In-memory state cache (populated from Redis pub/sub) ─────────────────────

interface StateCache {
  portfolio: unknown;
  signals: unknown[];
  proposals: unknown[];
  executions: unknown[];
  agents: Record<string, unknown>;
  stats: unknown;
  isHalted: boolean;
  haltReason?: string;
}

const state: StateCache = {
  portfolio: null,
  signals: [],
  proposals: [],
  executions: [],
  agents: {},
  stats: {},
  isHalted: false,
};

// ── REST Routes ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date() });
});

app.get("/api/v1/state", (_req, res) => {
  res.json({
    ...state,
    agentCount: Object.keys(state.agents).length,
    signalCount: state.signals.length,
    pendingProposals: state.proposals.length,
  });
});

app.get("/api/v1/portfolio", (_req, res) => {
  if (!state.portfolio) {
    return res.status(503).json({ error: "Portfolio data not yet available" });
  }
  res.json(state.portfolio);
});

app.get("/api/v1/signals", (_req, res) => {
  res.json({ signals: state.signals, count: state.signals.length });
});

app.get("/api/v1/proposals", (_req, res) => {
  res.json({ proposals: state.proposals, count: state.proposals.length });
});

app.get("/api/v1/executions", (req, res) => {
  const limit = Math.min(parseInt(req.query["limit"] as string ?? "20"), 100);
  res.json({ executions: state.executions.slice(0, limit) });
});

app.get("/api/v1/agents", (_req, res) => {
  res.json({ agents: Object.values(state.agents) });
});

// Auth middleware for mutation endpoints
const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== process.env["ADMIN_TOKEN"]) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.post("/api/v1/halt", requireAuth, async (_req, res) => {
  const pub = createClient({ url: process.env["REDIS_URL"] });
  await pub.connect();
  await pub.publish(CHANNELS.SWARM_HALT, JSON.stringify({
    channel: CHANNELS.SWARM_HALT,
    senderId: "api",
    payload: { reason: "Manual halt via API" },
    timestamp: new Date(),
  }));
  await pub.disconnect();
  state.isHalted = true;
  res.json({ success: true, message: "Halt signal sent" });
});

app.post("/api/v1/resume", requireAuth, async (_req, res) => {
  const pub = createClient({ url: process.env["REDIS_URL"] });
  await pub.connect();
  await pub.publish(CHANNELS.SWARM_RESUME, JSON.stringify({
    channel: CHANNELS.SWARM_RESUME,
    senderId: "api",
    payload: { resumedBy: "api" },
    timestamp: new Date(),
  }));
  await pub.disconnect();
  state.isHalted = false;
  res.json({ success: true, message: "Resume signal sent" });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on("connection", (ws: WebSocket) => {
  wsClients.add(ws);

  // Send current state snapshot on connect
  ws.send(JSON.stringify({ channel: "state:snapshot", payload: state, timestamp: new Date() }));

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  await redisSub.connect();

  // Subscribe to all swarm channels and forward to WebSocket clients
  const allChannels = Object.values(CHANNELS);

  for (const channel of allChannels) {
    await redisSub.subscribe(channel, (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg) as BusMessage;
        broadcast(channel, msg.payload);

        // Update in-memory state
        switch (channel) {
          case CHANNELS.PORTFOLIO_UPDATE:
            state.portfolio = msg.payload;
            break;
          case CHANNELS.SIGNAL_NEW:
            state.signals.unshift(msg.payload);
            if (state.signals.length > 50) state.signals.pop();
            break;
          case CHANNELS.PROPOSAL_NEW:
            state.proposals.unshift(msg.payload);
            if (state.proposals.length > 50) state.proposals.pop();
            break;
          case CHANNELS.EXECUTION_UPDATE: {
            const exec = msg.payload as { id: string };
            const idx = state.executions.findIndex((e) => (e as { id: string }).id === exec.id);
            if (idx >= 0) state.executions[idx] = exec;
            else state.executions.unshift(exec);
            if (state.executions.length > 100) state.executions.pop();
            break;
          }
          case CHANNELS.AGENT_HEARTBEAT: {
            const hb = msg.payload as { agentId: string };
            state.agents[hb.agentId] = hb;
            break;
          }
          case CHANNELS.SWARM_HALT:
            state.isHalted = true;
            break;
          case CHANNELS.SWARM_RESUME:
            state.isHalted = false;
            break;
        }
      } catch (err) {
        console.error("Failed to process bus message:", err);
      }
    });
  }

  const port = parseInt(process.env["API_PORT"] ?? "3001");
  const host = process.env["API_HOST"] ?? "0.0.0.0";

  httpServer.listen(port, host, () => {
    console.log(`🎼 Swarm Conductor API listening on ${host}:${port}`);
    console.log(`📡 WebSocket endpoint: ws://${host}:${port}/ws`);
  });
}

bootstrap().catch(console.error);

process.on("SIGTERM", async () => {
  await redisSub.disconnect();
  httpServer.close();
  process.exit(0);
});
