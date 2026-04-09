/**
 * Demo Script — Live Swarm Demonstration
 *
 * Runs a fully simulated swarm cycle that you can use during demos.
 * Injects realistic signals and shows the full consensus → execution pipeline.
 *
 * Perfect for: hackathon judging, investor demos, live presentations.
 *
 * Usage:
 *   pnpm demo
 *   DEMO_CAPITAL=50000 pnpm demo   # simulate with $50k portfolio
 */

import "dotenv/config";
import { createClient } from "redis";
import { CHANNELS } from "@swarm/shared";
import type { Signal, AgentProposal, AgentVote, ConsensusResult, ExecutionRecord } from "@swarm/shared";
import { nanoid } from "nanoid";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const CAPITAL = parseFloat(process.env["DEMO_CAPITAL"] ?? "10000");

const redis = createClient({ url: REDIS_URL });

type Publisher = {
  pub: (channel: string, payload: unknown) => Promise<void>;
};

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function pub(channel: string, payload: unknown) {
  return redis.publish(
    channel,
    JSON.stringify({
      channel,
      senderId: "demo-script",
      payload,
      timestamp: new Date(),
      correlationId: nanoid(8),
    })
  );
}

// ─── Demo scenarios ───────────────────────────────────────────────────────────

async function scenarioApySpikeAndRotate() {
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("SCENARIO: APY Spike Detected on Meteora");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await sleep(1000);

  // 1. Portfolio snapshot
  log("📊 Publishing portfolio snapshot...");
  await pub(CHANNELS.PORTFOLIO_UPDATE, {
    walletAddress: "Sw4rm7HiveMind9AbcDemoWallet",
    totalValueUsd: CAPITAL,
    idleUsdc: CAPITAL * 0.08,
    positions: [
      { id: "pos-1", protocol: "raydium", poolAddress: "RAYsol-usdc", valueUsd: CAPITAL * 0.38, pnlUsd: CAPITAL * 0.012, pnlPct: 0.032, currentApy: 28.4, entryValueUsd: CAPITAL * 0.37, openedAt: new Date(Date.now() - 86400000 * 3) },
      { id: "pos-2", protocol: "orca", poolAddress: "ORCAsol-usdt", valueUsd: CAPITAL * 0.32, pnlUsd: -CAPITAL * 0.003, pnlPct: -0.009, currentApy: 19.1, entryValueUsd: CAPITAL * 0.323, openedAt: new Date(Date.now() - 86400000 * 7) },
      { id: "pos-3", protocol: "meteora", poolAddress: "METsol-msol", valueUsd: CAPITAL * 0.22, pnlUsd: CAPITAL * 0.018, pnlPct: 0.082, currentApy: 34.2, entryValueUsd: CAPITAL * 0.202, openedAt: new Date(Date.now() - 86400000 * 1) },
    ],
    dailyReturnPct: 0.0028,
    allTimeReturnPct: 0.127,
    lastUpdated: new Date(),
  });
  await sleep(800);

  // 2. Heartbeats from all agents
  log("💓 Agents coming online...");
  for (const role of ["researcher", "risk-assessor", "executor", "rebalancer"]) {
    await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: `${role}-demo`, role, status: "idle", timestamp: new Date() });
    await sleep(200);
  }
  await sleep(500);

  // 3. Signal
  log("📡 SIGNAL DETECTED: Meteora SOL-mSOL APY spiked from 34% → 78%!");
  const signalId = nanoid(16);
  const signal: Signal = {
    id: signalId,
    type: "apy_spike",
    priority: "high",
    source: "on-chain",
    data: {
      poolAddress: "METsol-msol-clmm",
      protocol: "meteora",
      previousApy: 34.2,
      currentApy: 78.4,
      changePct: 1.29,
      tvlUsd: 8_400_000,
      volumeSpike: true,
    },
    confidence: 0.87,
    detectedAt: new Date(),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  await pub(CHANNELS.SIGNAL_NEW, signal);
  await sleep(1500);

  // 4. Researcher proposes
  log("🔭 RESEARCHER: Analyzing APY spike... generating proposal");
  await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: "researcher-demo", role: "researcher", status: "analyzing", timestamp: new Date() });
  await sleep(2000);

  const proposalId = nanoid(16);
  const proposal: AgentProposal = {
    id: proposalId,
    agentId: "researcher-demo",
    agentRole: "researcher",
    signalId,
    action: {
      type: "rebalance",
      params: {
        fromPool: "RAYsol-usdc",
        toPool: "METsol-msol-clmm",
        fromProtocol: "raydium",
        toProtocol: "meteora",
        fraction: 0.40,
        reason: "APY spike: Meteora SOL-mSOL jumped from 34% to 78% — capturing 44% APY gain by rotating 40% of Raydium position",
        estimatedApyGain: 49.8,
        estimatedCostBps: 28,
      },
    },
    reasoning: "Meteora SOL-mSOL CLMM pool APY spiked from 34% to 78% in the last 15 minutes. TVL is stable at $8.4M, ruling out a temporary liquidity manipulation. The 44% APY differential justifies the swap cost. Break-even is 5.1 hours. Recommend rotating 40% of our Raydium position.",
    confidence: 0.83,
    expectedReturnUsd: CAPITAL * 0.40 * 0.499 / 365 * 30,
    maxDownsideUsd: CAPITAL * 0.40 * 0.005,
    estimatedGasLamports: 6_200,
    urgency: "high",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  };
  await pub(CHANNELS.PROPOSAL_NEW, proposal);
  await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: "researcher-demo", role: "researcher", status: "idle", timestamp: new Date() });
  await sleep(1000);

  // 5. Voting round
  log("🗳️  SWARM VOTING in progress...");

  const votes: Array<{ agentId: string; agentRole: string; decision: AgentVote["decision"]; reasoning: string; weight: number }> = [
    { agentId: "researcher-demo", agentRole: "researcher", decision: "approve", reasoning: "APY differential is real and sustainable based on TVL stability and volume data.", weight: 1.0 },
    { agentId: "risk-assessor-demo", agentRole: "risk-assessor", decision: "approve", reasoning: "Risk score 38/100. Meteora is audited, TVL healthy, IL risk low for correlated SOL/mSOL pair. Approving.", weight: 1.5 },
    { agentId: "executor-demo", agentRole: "executor", decision: "approve", reasoning: "Technically sound. 0.40 fraction within limits. Jupiter routing available. Estimated gas 6,200 lamports.", weight: 0.8 },
    { agentId: "rebalancer-demo", agentRole: "rebalancer", decision: "approve", reasoning: "Post-trade Raydium exposure drops to 22% vs 35% target — improves allocation health.", weight: 1.0 },
  ];

  for (const vote of votes) {
    await sleep(800);
    await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: vote.agentId, role: vote.agentRole, status: "voting", timestamp: new Date() });
    await pub(CHANNELS.VOTE_CAST, {
      agentId: vote.agentId,
      agentRole: vote.agentRole,
      proposalId,
      decision: vote.decision,
      confidence: 0.72 + Math.random() * 0.22,
      reasoning: vote.reasoning,
      votedAt: new Date(),
    } as AgentVote);
    log(`  ${vote.decision === "approve" ? "✅" : vote.decision === "reject" ? "❌" : "⊘"} ${vote.agentRole} voted ${vote.decision} (${(vote.weight * 100).toFixed(0)}% weight)`);
    await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: vote.agentId, role: vote.agentRole, status: "idle", timestamp: new Date() });
  }
  await sleep(600);

  // 6. Consensus
  const consensus: ConsensusResult = {
    proposalId,
    passed: true,
    approveCount: 4,
    rejectCount: 0,
    abstainCount: 0,
    totalVotes: 4,
    weightedScore: 0.93,
    finalAction: proposal.action,
    consensusAt: new Date(),
  };
  log(`\n🤝 CONSENSUS: PASSED (93% weighted approval)`);
  log(`   Action: ${proposal.action.type.toUpperCase()} — rotating $${(CAPITAL * 0.40).toFixed(0)} from Raydium → Meteora`);
  await pub(CHANNELS.CONSENSUS_REACHED, consensus);
  await sleep(800);

  // 7. Execution
  log("\n⚡ EXECUTOR: Simulating transaction...");
  const execId = nanoid(16);
  const execBase: ExecutionRecord = {
    id: execId,
    consensusResultId: proposalId,
    action: proposal.action,
    status: "simulating",
    txSignatures: [],
    gasUsedLamports: 0,
    actualSlippageBps: 0,
  };
  await pub(CHANNELS.EXECUTION_UPDATE, execBase);
  await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: "executor-demo", role: "executor", status: "executing", timestamp: new Date() });
  await sleep(1200);

  log("   Simulation: ✅ Clean — no warnings");
  log("   Fetching Jupiter quote...");
  await sleep(800);
  log("   Route found: RAY → USDC → SOL → mSOL (2 hops, 18bps slippage)");
  await sleep(600);

  log("   Submitting transaction...");
  await pub(CHANNELS.EXECUTION_UPDATE, { ...execBase, status: "submitted", submittedAt: new Date() });
  await sleep(1500);

  const txSig = `5Kx${nanoid(8)}...${nanoid(6)}`;
  await pub(CHANNELS.EXECUTION_UPDATE, {
    ...execBase,
    status: "confirmed",
    txSignatures: [txSig],
    gasUsedLamports: 6_180,
    actualSlippageBps: 18,
    confirmedAt: new Date(),
    submittedAt: new Date(Date.now() - 1500),
  } as ExecutionRecord);
  await pub(CHANNELS.AGENT_HEARTBEAT, { agentId: "executor-demo", role: "executor", status: "idle", timestamp: new Date() });

  log(`\n✅ EXECUTION CONFIRMED`);
  log(`   Tx: ${txSig}`);
  log(`   Gas used: 6,180 lamports ($0.0009)`);
  log(`   Actual slippage: 18bps`);
  log(`   $${(CAPITAL * 0.40).toFixed(2)} now earning ~78.4% APY on Meteora`);
  await sleep(800);

  // 8. Portfolio update post-trade
  log("\n📊 Portfolio updated post-rebalance...");
  await pub(CHANNELS.PORTFOLIO_UPDATE, {
    walletAddress: "Sw4rm7HiveMind9AbcDemoWallet",
    totalValueUsd: CAPITAL * 1.0028,
    idleUsdc: CAPITAL * 0.08,
    positions: [
      { id: "pos-1", protocol: "raydium", poolAddress: "RAYsol-usdc", valueUsd: CAPITAL * 0.228, pnlUsd: CAPITAL * 0.012, pnlPct: 0.032, currentApy: 28.4, entryValueUsd: CAPITAL * 0.37 },
      { id: "pos-2", protocol: "orca", poolAddress: "ORCAsol-usdt", valueUsd: CAPITAL * 0.32, pnlUsd: -CAPITAL * 0.003, pnlPct: -0.009, currentApy: 19.1, entryValueUsd: CAPITAL * 0.323 },
      { id: "pos-3", protocol: "meteora", poolAddress: "METsol-msol", valueUsd: CAPITAL * 0.22, pnlUsd: CAPITAL * 0.018, pnlPct: 0.082, currentApy: 34.2, entryValueUsd: CAPITAL * 0.202 },
      { id: "pos-4", protocol: "meteora", poolAddress: "METsol-msol-clmm", valueUsd: CAPITAL * 0.172, pnlUsd: 0, pnlPct: 0, currentApy: 78.4, entryValueUsd: CAPITAL * 0.172 },
    ],
    dailyReturnPct: 0.0028,
    allTimeReturnPct: 0.127,
    lastUpdated: new Date(),
  });

  log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("DEMO COMPLETE — Swarm rotated portfolio in real-time");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log(`Elapsed: ~${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

let startTime = 0;

async function main() {
  await redis.connect();
  log("Connected to Redis");
  log(`Capital: $${CAPITAL.toLocaleString()}`);
  log("");

  startTime = Date.now();

  await scenarioApySpikeAndRotate();

  await sleep(2000);
  await redis.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo error:", err);
  process.exit(1);
});
