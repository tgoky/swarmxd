/**
 * Swarm Conductor Bootstrap
 *
 * Architecture:
 * - WALLET_PRIVATE_KEY is the PLATFORM executor wallet (server-side only, never user-facing)
 * - Users deposit SOL to this wallet's public address (= NEXT_PUBLIC_VAULT_ADDRESS)
 * - The executor trades those funds on their behalf
 * - Think of it as a fund manager wallet — users deposit, swarm trades
 *
 * To set up:
 *   solana-keygen new --outfile vault.json
 *   WALLET_PRIVATE_KEY=$(cat vault.json)   ← add to .env
 *   NEXT_PUBLIC_VAULT_ADDRESS=$(solana address -k vault.json)  ← add to .env
 *   solana airdrop 2 <VAULT_ADDRESS> --url testnet
 */

import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import { MessageBus, createLogger, type SwarmConfig } from "@swarm/shared";
import { SwarmConductor } from "@swarm/conductor";
import { ResearcherAgent } from "@swarm/agent-researcher";
import { RiskAssessorAgent } from "@swarm/agent-risk-assessor";
import { ExecutorAgent } from "@swarm/agent-executor";
import { RebalancerAgent } from "@swarm/agent-rebalancer";
import type { AgentDependencies } from "@swarm/shared";

// ── Env validation ─────────────────────────────────────────────────────────────

const REQUIRED_ENV = ["SOLANA_RPC_URL", "REDIS_URL"];

if (!process.env["OPENROUTER_API_KEY"] && !process.env["ANTHROPIC_API_KEY"]) {
  console.error("❌  Missing LLM key — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required env var: ${key}  (copy .env.example → .env)`);
    process.exit(1);
  }
}

// ── Derive executor wallet from private key ────────────────────────────────────

function loadExecutorKeypair(): Keypair | null {
  const raw = process.env["WALLET_PRIVATE_KEY"];
  if (!raw) return null;
  try {
    const bytes = Buffer.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(bytes);
  } catch {
    console.error("❌  WALLET_PRIVATE_KEY is malformed — must be a JSON byte array");
    console.error("    Generate:  solana-keygen new --outfile vault.json");
    console.error("    Then:      WALLET_PRIVATE_KEY=$(cat vault.json) in .env");
    process.exit(1);
  }
}

const executorKeypair = loadExecutorKeypair();
const walletAddress = executorKeypair?.publicKey.toBase58() ?? "11111111111111111111111111111111";

const logger = createLogger({ agentRole: "conductor", agentId: "bootstrap" });

// ── Config ─────────────────────────────────────────────────────────────────────

const config: SwarmConfig = {
  solana: {
    rpcUrl: process.env["SOLANA_RPC_URL"]!,
    wsUrl:
      process.env["SOLANA_WS_URL"] ??
      process.env["SOLANA_RPC_URL"]!.replace("https://", "wss://"),
    network:
      (process.env["SOLANA_NETWORK"] as SwarmConfig["solana"]["network"]) ?? "testnet",
  },
  risk: {
    maxPortfolioValueUsd: parseFloat(process.env["MAX_PORTFOLIO_VALUE_USD"] ?? "100000"),
    maxTradeSizePct: parseFloat(process.env["MAX_TRADE_SIZE_PCT"] ?? "0.25"),
    stopLossPct: parseFloat(process.env["STOP_LOSS_PCT"] ?? "0.10"),
    maxSlippageBps: parseInt(process.env["MAX_SLIPPAGE_BPS"] ?? "100"),
    humanApprovalThresholdUsd: parseFloat(
      process.env["HUMAN_APPROVAL_THRESHOLD_USD"] ?? "5000"
    ),
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

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function main() {
  logger.info("═══════════════════════════════════════════════");
  logger.info("  🎼  SWARM CONDUCTOR — DeFi Orchestra v1.0");
  logger.info("═══════════════════════════════════════════════");
  logger.info(
    { network: config.solana.network, dryRun: process.env["DRY_RUN"] === "true", walletAddress },
    "Starting swarm"
  );

  if (!executorKeypair) {
    logger.warn("WALLET_PRIVATE_KEY not set — executor runs in simulation mode (no real txns)");
    logger.warn("To enable real trading:");
    logger.warn("  1. solana-keygen new --outfile vault.json");
    logger.warn("  2. Add to .env:  WALLET_PRIVATE_KEY=$(cat vault.json)");
    logger.warn(`  3. solana airdrop 2 ${walletAddress} --url ${config.solana.network}`);
  } else {
    logger.info({ vaultAddress: walletAddress }, "✅ Executor wallet loaded");
  }

  const llmApiKey =
    process.env["OPENROUTER_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"]!;

  const initialPortfolio = {
    walletAddress,
    totalValueUsd: 0,
    positions: [],
    idleUsdc: 0,
    lastUpdated: new Date(),
    allTimeReturnPct: 0,
    dailyReturnPct: 0,
  };

  const makeAgentDeps = (agentId: string): AgentDependencies => ({
    bus: new MessageBus(
      process.env["REDIS_URL"]!,
      agentId,
      createLogger({ agentRole: agentId.split("-")[0] as never, agentId })
    ),
    config,
    llmApiKey,
  });

  // ── Instantiate ─────────────────────────────────────────────────────────────
  // Note: conductorBus is NOT connected here — conductor.start() does it.
  // Agent buses ARE connected here because BaseAgent.start() doesn't connect them.

  const conductorBus = new MessageBus(
    process.env["REDIS_URL"]!,
    "conductor-main",
    createLogger({ agentRole: "conductor", agentId: "conductor-main" })
  );

  const conductor = new SwarmConductor(config, conductorBus, initialPortfolio);
  const researcher = new ResearcherAgent(makeAgentDeps("researcher-1"));
  const riskAssessor = new RiskAssessorAgent(makeAgentDeps("risk-assessor-1"));
  const executor = new ExecutorAgent(makeAgentDeps("executor-1"));
  const rebalancer = new RebalancerAgent(makeAgentDeps("rebalancer-1"));

  // Cast to access protected bus field
  type WithBus = { bus: MessageBus };

  await Promise.all([
    (researcher as unknown as WithBus).bus.connect(),
    (riskAssessor as unknown as WithBus).bus.connect(),
    (executor as unknown as WithBus).bus.connect(),
    (rebalancer as unknown as WithBus).bus.connect(),
  ]);

  logger.info("Starting sub-agents…");

  await Promise.all([
    researcher.start(),
    riskAssessor.start(),
    executor.start(),
    rebalancer.start(),
  ]);

  logger.info("Starting conductor…");
  await conductor.start(); // connects conductorBus, starts signal detector, begins ticking

  logger.info("✅ Swarm fully operational");
  logger.info(`   Vault/executor address: ${walletAddress}`);
  logger.info("   Dashboard:              http://localhost:3000");
  logger.info("   API:                    http://localhost:3001/api/v1/state");

  // ── Graceful shutdown ───────────────────────────────────────────────────────

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
      (researcher as unknown as WithBus).bus.disconnect(),
      (riskAssessor as unknown as WithBus).bus.disconnect(),
      (executor as unknown as WithBus).bus.disconnect(),
      (rebalancer as unknown as WithBus).bus.disconnect(),
    ]);

    logger.info("Swarm shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — shutting down");
    void shutdown("uncaughtException");
  });
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
