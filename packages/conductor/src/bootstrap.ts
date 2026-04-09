/**
 * Swarm Conductor Bootstrap
 *
 * Starts the full swarm:
 * 1. Validates environment
 * 2. Connects to Redis message bus
 * 3. Initializes conductor
 * 4. Spawns all 4 sub-agents
 * 5. Wires graceful shutdown
 *
 * In production: each agent would run in its own process/container
 * for true fault isolation. This monolithic mode is for development
 * and demo purposes.
 *
 * Usage:
 *   pnpm conductor:start         # production
 *   DRY_RUN=true pnpm conductor:start  # simulation (no real txns)
 */

import "dotenv/config";
import { MessageBus, createLogger, type SwarmConfig } from "@swarm/shared";
import { SwarmConductor } from "@swarm/conductor";
import { ResearcherAgent } from "@swarm/agent-researcher";
import { RiskAssessorAgent } from "@swarm/agent-risk-assessor";
import { ExecutorAgent } from "@swarm/agent-executor";
import { RebalancerAgent } from "@swarm/agent-rebalancer";
import type { AgentDependencies } from "@swarm/shared";

// ─── Env validation ───────────────────────────────────────────────────────────

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "SOLANA_RPC_URL", "REDIS_URL"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    console.error(`   Copy .env.example to .env and fill in the values.`);
    process.exit(1);
  }
}

const logger = createLogger({ agentRole: "conductor", agentId: "bootstrap" });

// ─── Config ───────────────────────────────────────────────────────────────────

const config: SwarmConfig = {
  solana: {
    rpcUrl: process.env["SOLANA_RPC_URL"]!,
    wsUrl: process.env["SOLANA_WS_URL"] ?? process.env["SOLANA_RPC_URL"]!.replace("https://", "wss://"),
    network: (process.env["SOLANA_NETWORK"] as SwarmConfig["solana"]["network"]) ?? "mainnet-beta",
  },
  risk: {
    maxPortfolioValueUsd: parseFloat(process.env["MAX_PORTFOLIO_VALUE_USD"] ?? "100000"),
    maxTradeSizePct: parseFloat(process.env["MAX_TRADE_SIZE_PCT"] ?? "0.25"),
    stopLossPct: parseFloat(process.env["STOP_LOSS_PCT"] ?? "0.10"),
    maxSlippageBps: parseInt(process.env["MAX_SLIPPAGE_BPS"] ?? "100"),
    humanApprovalThresholdUsd: parseFloat(process.env["HUMAN_APPROVAL_THRESHOLD_USD"] ?? "5000"),
  },
  conductor: {
    tickMs: parseInt(process.env["CONDUCTOR_TICK_MS"] ?? "30000"),
    consensusThreshold: parseFloat(process.env["CONSENSUS_THRESHOLD"] ?? "0.75"),
    agentTimeoutMs: parseInt(process.env["AGENT_TIMEOUT_MS"] ?? "15000"),
  },
  protocols: {
    enabled: ["jupiter", "raydium", "orca", "meteora", "kamino"],
    maxExposurePct: {
      jupiter: 0,
      raydium: 0.35,
      orca: 0.30,
      meteora: 0.25,
      lifinity: 0.10,
      whirlpool: 0.20,
      drift: 0.10,
      mango: 0.10,
      kamino: 0.20,
    },
  },
};

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  logger.info("═══════════════════════════════════════════════");
  logger.info("  🎼  SWARM CONDUCTOR — DeFi Orchestra v1.0");
  logger.info("═══════════════════════════════════════════════");
  logger.info({ network: config.solana.network, dryRun: !!process.env["DRY_RUN"] }, "Starting swarm");

  if (process.env["DRY_RUN"]) {
    logger.warn("DRY_RUN mode — no real transactions will be submitted");
  }

  // Create a shared message bus instance for this process
  // In multi-process mode, each agent creates its own bus connection
  const conductorBus = new MessageBus(
    process.env["REDIS_URL"]!,
    "conductor-main",
    createLogger({ agentRole: "conductor", agentId: "conductor-main" })
  );

  await conductorBus.connect();

  // Build agent dependency bundle
  const agentDeps = (agentId: string): AgentDependencies => ({
    bus: new MessageBus(
      process.env["REDIS_URL"]!,
      agentId,
      createLogger({ agentRole: "researcher", agentId })
    ),
    config,
    anthropicApiKey: process.env["ANTHROPIC_API_KEY"]!,
  });

  // ── Instantiate agents ────────────────────────────────────────────────────

  const walletAddress = process.env["WALLET_PUBLIC_KEY"] ?? "11111111111111111111111111111111";

  const dummyPortfolio = {
    walletAddress,
    totalValueUsd: 0,
    positions: [],
    idleUsdc: 0,
    lastUpdated: new Date(),
    allTimeReturnPct: 0,
    dailyReturnPct: 0,
  };

  const conductor = new SwarmConductor(config, conductorBus, dummyPortfolio);
  const researcher = new ResearcherAgent(agentDeps("researcher-1"));
  const riskAssessor = new RiskAssessorAgent(agentDeps("risk-assessor-1"));
  const executor = new ExecutorAgent(agentDeps("executor-1"));
  const rebalancer = new RebalancerAgent(agentDeps("rebalancer-1"));

  // Connect all agent buses
  await Promise.all([
    researcher["bus"].connect(),
    riskAssessor["bus"].connect(),
    executor["bus"].connect(),
    rebalancer["bus"].connect(),
  ]);

  // ── Start all agents ──────────────────────────────────────────────────────

  logger.info("Starting sub-agents…");

  await Promise.all([
    researcher.start(),
    riskAssessor.start(),
    executor.start(),
    rebalancer.start(),
  ]);

  logger.info("Starting conductor…");
  await conductor.start();

  logger.info("✅ Swarm is fully operational");
  logger.info("   Dashboard: http://localhost:3001 (open apps/dashboard/public/index.html)");
  logger.info("   API: http://localhost:3001/api/v1/state");
  logger.info("   WebSocket: ws://localhost:3001/ws");

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    await conductor.stop();
    await Promise.all([
      researcher.stop(),
      riskAssessor.stop(),
      executor.stop(),
      rebalancer.stop(),
    ]);

    await Promise.all([
      researcher["bus"].disconnect(),
      riskAssessor["bus"].disconnect(),
      executor["bus"].disconnect(),
      rebalancer["bus"].disconnect(),
      conductorBus.disconnect(),
    ]);

    logger.info("Swarm shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
