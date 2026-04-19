/**
 * SwarmConductor — The orchestrator.
 *
 * Responsibilities:
 * 1. Monitor on-chain signals + data feeds
 * 2. Dispatch signals to all agents simultaneously
 * 3. Collect proposals from agents
 * 4. Run weighted consensus voting
 * 5. Hand approved actions to the Executor
 * 6. Write outcomes to on-chain memory (PDAs)
 * 7. Maintain circuit breakers & stop-loss monitoring
 *
 * Architecture note: The conductor does NOT make trading decisions itself.
 * It is a pure orchestrator. All intelligence is in the sub-agents.
 */

import { nanoid } from "nanoid";
import type {
  Signal,
  AgentProposal,
  AgentVote,
  ConsensusResult,
  SwarmState,
  SwarmConfig,
  SwarmStats,
  Portfolio,
  ExecutionRecord,
} from "@swarm/shared";
import { CHANNELS, MessageBus, createLogger } from "@swarm/shared";
import { SignalDetector } from "./signal-detector.js";
import { PortfolioMonitor } from "./portfolio-monitor.js";
import { OnChainMemory } from "./on-chain-memory.js";
import { RiskGuard } from "./risk-guard.js";

// Vote weights by role — risk assessor has veto-adjacent power
const VOTE_WEIGHTS: Record<string, number> = {
  researcher: 1.0,
  "risk-assessor": 1.5,
  executor: 0.8,
  rebalancer: 1.0,
};

export class SwarmConductor {
  private readonly id = `conductor-${nanoid(8)}`;
  private readonly logger;
  private readonly bus: MessageBus;
  private readonly signalDetector: SignalDetector;
  private readonly portfolioMonitor: PortfolioMonitor;
  private readonly onChainMemory: OnChainMemory;
  private readonly riskGuard: RiskGuard;

  // In-flight state
  private proposals = new Map<string, AgentProposal[]>(); // signalId → proposals
  private votes = new Map<string, AgentVote[]>();          // proposalId → votes
  private pendingProposals = new Map<string, AgentProposal>(); // proposalId → proposal

  private state: SwarmState;
  private tickInterval?: NodeJS.Timeout;
  private readonly proposalTTL = 60_000; // proposals expire after 60s
  private readonly votingWindow = 10_000; // wait 10s for all votes

  constructor(
    private readonly config: SwarmConfig,
    bus: MessageBus,
    portfolio: Portfolio
  ) {
    this.logger = createLogger({ agentRole: "conductor", agentId: this.id });
    this.bus = bus;
    this.signalDetector = new SignalDetector(config, this.logger);
    this.portfolioMonitor = new PortfolioMonitor(config, this.logger);
    this.onChainMemory = new OnChainMemory(config, this.logger);
    this.riskGuard = new RiskGuard(config, this.logger);

    this.state = {
      conductorId: this.id,
      epoch: 0,
      agents: new Map(),
      portfolio,
      activeSignals: [],
      pendingProposals: [],
      activeVotes: new Map(),
      recentExecutions: [],
      isHalted: false,
      stats: this.blankStats(),
    };
  }

  async start(): Promise<void> {
    this.logger.info("Swarm Conductor starting up");

    // bus may already be connected if bootstrap connected it; connect is idempotent
    try { await this.bus.connect(); } catch { /* already connected */ }
    await this.onChainMemory.initialize();
    await this.portfolioMonitor.start(this.state.portfolio.walletAddress);
    await this.signalDetector.start();

    this.registerBusHandlers();

    // Main orchestration tick
    this.tickInterval = setInterval(() => this.tick().catch((e) =>
      this.logger.error({ err: e }, "Tick error")
    ), this.config.conductor.tickMs);

    this.logger.info({ conductorId: this.id }, "Conductor ready — swarm is live");
  }

  async stop(): Promise<void> {
    clearInterval(this.tickInterval);
    await this.signalDetector.stop();
    await this.portfolioMonitor.stop();
    await this.bus.publish(CHANNELS.SWARM_HALT, { reason: "conductor shutdown" });
    await new Promise((r) => setTimeout(r, 1000)); // let halt message propagate
    await this.bus.disconnect();
    this.logger.info("Conductor stopped");
  }

  getState(): SwarmState {
    return { ...this.state };
  }

  // ── Main tick ─────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.state.isHalted) return;

    this.state.epoch++;
    this.logger.debug({ epoch: this.state.epoch }, "Conductor tick");

    // 1. Refresh portfolio state and broadcast to dashboard via Redis
    const updatedPortfolio = await this.portfolioMonitor.getPortfolio();
    this.state.portfolio = updatedPortfolio;
    await this.bus.publish(CHANNELS.PORTFOLIO_UPDATE, updatedPortfolio);

    // 2. Check stop-loss circuit breaker
    const stopLossBreach = this.riskGuard.checkStopLoss(updatedPortfolio);
    if (stopLossBreach) {
      await this.emergencyHalt(`Stop-loss breached: ${stopLossBreach}`);
      return;
    }

    // 3. Detect new signals
    const newSignals = await this.signalDetector.detectSignals(updatedPortfolio);

    for (const signal of newSignals) {
      this.state.activeSignals.push(signal);
      this.logger.info({ signalId: signal.id, type: signal.type, priority: signal.priority }, "Signal detected");
      await this.bus.publish(CHANNELS.SIGNAL_NEW, signal);
    }

    // 4. Expire old signals
    const now = Date.now();
    this.state.activeSignals = this.state.activeSignals.filter(
      (s) => !s.expiresAt || s.expiresAt.getTime() > now
    );

    // 5. Check if any pending proposals have enough votes to reach consensus
    for (const [proposalId, proposalVotes] of this.votes.entries()) {
      const proposal = this.pendingProposals.get(proposalId);
      if (!proposal) continue;

      // If we have votes from all 4 agents OR voting window expired
      const expectedVoters = 4;
      const hasAllVotes = proposalVotes.length >= expectedVoters;
      const windowExpired = proposal.createdAt.getTime() + this.votingWindow < now;

      if (hasAllVotes || windowExpired) {
        await this.finalizeConsensus(proposal, proposalVotes);
      }
    }
  }

  // ── Bus message handlers ──────────────────────────────────────────────────

  private registerBusHandlers(): void {
    // Collect agent proposals
    this.bus.subscribe<AgentProposal>(CHANNELS.PROPOSAL_NEW, async (msg) => {
      const proposal = msg.payload;
      this.logger.info(
        { proposalId: proposal.id, agent: proposal.agentRole, action: proposal.action.type, confidence: proposal.confidence },
        "Proposal received"
      );

      this.pendingProposals.set(proposal.id, proposal);

      const existing = this.proposals.get(proposal.signalId) ?? [];
      existing.push(proposal);
      this.proposals.set(proposal.signalId, existing);
      this.votes.set(proposal.id, []);

      // Broadcast proposal so other agents can vote on it
      // (Each agent votes on ALL proposals, even ones they didn't author)
      await this.broadcastForVoting(proposal);
    });

    // Collect votes
    this.bus.subscribe<AgentVote>(CHANNELS.VOTE_CAST, async (msg) => {
      const vote = msg.payload;
      const existing = this.votes.get(vote.proposalId) ?? [];

      // Deduplicate — one vote per agent per proposal
      const alreadyVoted = existing.some((v) => v.agentId === vote.agentId);
      if (alreadyVoted) return;

      existing.push(vote);
      this.votes.set(vote.proposalId, existing);

      this.logger.info(
        { proposalId: vote.proposalId, voter: vote.agentRole, decision: vote.decision },
        "Vote received"
      );
    });

    // Track execution outcomes
    this.bus.subscribe<ExecutionRecord>(CHANNELS.EXECUTION_UPDATE, async (msg) => {
      const record = msg.payload;
      const existing = this.state.recentExecutions;
      const idx = existing.findIndex((r) => r.id === record.id);
      if (idx >= 0) {
        existing[idx] = record;
      } else {
        existing.unshift(record);
        if (existing.length > 100) existing.pop();
      }

      if (record.status === "confirmed") {
        await this.onExecutionConfirmed(record);
      } else if (record.status === "failed") {
        this.logger.error({ executionId: record.id, error: record.errorMessage }, "Execution failed");
      }
    });

    // Agent heartbeats — track which agents are alive
    this.bus.subscribe(CHANNELS.AGENT_HEARTBEAT, async (msg: { payload: { agentId: string; role: string; status: string; timestamp: Date } }) => {
      const { agentId, role, status, timestamp } = msg.payload;
      const existing = this.state.agents.get(agentId);
      if (existing) {
        existing.lastHeartbeat = new Date(timestamp);
        (existing as { status: string }).status = status;
      } else {
        this.state.agents.set(agentId, {
          id: agentId,
          role: role as AgentRole,
          version: "1.0.0",
          startedAt: new Date(timestamp),
          lastHeartbeat: new Date(timestamp),
        });
        this.logger.info({ agentId, role }, "New agent joined swarm");
      }
    });
  }

  // ── Consensus logic ───────────────────────────────────────────────────────

  private async broadcastForVoting(proposal: AgentProposal): Promise<void> {
    // The proposal is already on PROPOSAL_NEW channel — agents self-subscribe and vote.
    // Conductor just logs the expectation.
    this.logger.debug({ proposalId: proposal.id }, "Awaiting votes from swarm agents");
  }

  private async finalizeConsensus(
    proposal: AgentProposal,
    votes: AgentVote[]
  ): Promise<void> {
    // Clean up tracking maps
    this.votes.delete(proposal.id);
    this.pendingProposals.delete(proposal.id);

    // Count weighted votes
    let approveWeight = 0;
    let rejectWeight = 0;
    let totalWeight = 0;

    for (const vote of votes) {
      const weight = VOTE_WEIGHTS[vote.agentRole] ?? 1.0;
      totalWeight += weight;
      if (vote.decision === "approve") approveWeight += weight;
      else if (vote.decision === "reject") rejectWeight += weight;
    }

    const weightedScore = totalWeight > 0 ? approveWeight / totalWeight : 0;
    const passed = weightedScore >= this.config.conductor.consensusThreshold;

    const result: ConsensusResult = {
      proposalId: proposal.id,
      passed,
      approveCount: votes.filter((v) => v.decision === "approve").length,
      rejectCount: votes.filter((v) => v.decision === "reject").length,
      abstainCount: votes.filter((v) => v.decision === "abstain").length,
      totalVotes: votes.length,
      weightedScore,
      finalAction: passed ? proposal.action : null,
      consensusAt: new Date(),
    };

    this.logger.info(
      {
        proposalId: proposal.id,
        passed,
        weightedScore: weightedScore.toFixed(3),
        approveCount: result.approveCount,
        rejectCount: result.rejectCount,
        action: proposal.action.type,
      },
      passed ? "✅ Consensus PASSED — dispatching to executor" : "❌ Consensus REJECTED"
    );

    await this.bus.publish(CHANNELS.CONSENSUS_REACHED, result);

    if (passed) {
      // Final risk guard check before execution
      const riskVeto = this.riskGuard.vetoCheck(proposal, this.state.portfolio);
      if (riskVeto) {
        this.logger.warn({ reason: riskVeto }, "Risk guard vetoed approved proposal");
        return;
      }

      // Executor picks this up from CONSENSUS_REACHED channel
    }
  }

  private async onExecutionConfirmed(record: ExecutionRecord): Promise<void> {
    // Update stats
    this.state.stats.totalTradesExecuted++;
    this.state.stats.lastExecutionAt = new Date();

    // Write to on-chain memory
    await this.onChainMemory.writeEntry({
      sequenceNumber: this.state.stats.totalTradesExecuted,
      signalId: "n/a", // would be populated from proposal
      proposalId: record.consensusResultId,
      consensusHash: this.hashConsensus(record),
      actionSummary: `${record.action.type} executed via ${record.txSignatures[0]?.slice(0, 8)}...`,
      txSignatures: record.txSignatures,
      netPnlUsd: 0, // updated when position closes
      timestamp: Math.floor(Date.now() / 1000),
      agents: Array.from(this.state.agents.keys()),
    });

    this.logger.info(
      { executionId: record.id, txSig: record.txSignatures[0] },
      "Execution confirmed and recorded on-chain"
    );
  }

  // ── Emergency controls ────────────────────────────────────────────────────

  async emergencyHalt(reason: string): Promise<void> {
    this.logger.error({ reason }, "🚨 EMERGENCY HALT — broadcasting to all agents");
    this.state.isHalted = true;
    this.state.haltReason = reason;
    await this.bus.publish(CHANNELS.SWARM_HALT, { reason });
  }

  async resume(): Promise<void> {
    if (!this.state.isHalted) return;
    this.state.isHalted = false;
    this.state.haltReason = undefined;
    await this.bus.publish(CHANNELS.SWARM_RESUME, { resumedBy: this.id });
    this.logger.info("Swarm resumed");
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private hashConsensus(record: ExecutionRecord): string {
    // Simple deterministic hash — replace with keccak256 in production
    const data = `${record.id}:${record.action.type}:${record.txSignatures.join(",")}`;
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }

  private blankStats(): SwarmStats {
    return {
      totalTradesExecuted: 0,
      totalVolumeUsd: 0,
      totalPnlUsd: 0,
      totalPnlPct: 0,
      winRate: 0,
      avgApyAchieved: 0,
      uptimeSeconds: 0,
    };
  }
}

// Re-export type for convenience
type AgentRole = import("@swarm/shared").AgentRole;