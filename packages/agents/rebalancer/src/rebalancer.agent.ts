/**
 * RebalancerAgent — Portfolio optimization engine.
 *
 * The rebalancer maintains optimal portfolio allocation over time.
 * Unlike the researcher (which reacts to signals), the rebalancer
 * proactively monitors allocation drift and proposes corrections.
 *
 * Responsibilities:
 * - Track target vs actual allocation weights
 * - Identify when rebalancing saves more in fees than it costs
 * - Harvest idle rewards and compound them
 * - Identify correlated positions that compound tail risk
 * - Propose portfolio restructuring during low-gas periods
 *
 * Mental model: think of this as the portfolio's "housekeeping" agent.
 * It doesn't find new opportunities (that's the researcher) —
 * it keeps the existing portfolio clean, efficient, and within targets.
 */

import type {
  Signal,
  AgentProposal,
  Portfolio,
  PoolData,
  ActionParams,
} from "@swarm/shared";
import {
  BaseAgent,
  CHANNELS,
  type AgentDependencies,
} from "@swarm/shared";

interface AllocationTarget {
  protocol: string;
  targetPct: number;
  actualPct: number;
  driftPct: number;
  valueUsd: number;
}

interface RebalanceOpportunity {
  type: "drift_correction" | "reward_harvest" | "fee_optimization" | "risk_reduction";
  description: string;
  estimatedGainUsd: number;
  estimatedCostUsd: number;
  netBenefit: number;
  urgency: "low" | "medium" | "high";
  action: ActionParams;
}

export class RebalancerAgent extends BaseAgent {
  private latestPortfolio?: Portfolio;
  private latestPoolData: PoolData[] = [];

  // Target allocation — in production this is configurable per-swarm
  private readonly targetAllocations: Record<string, number> = {
    raydium: 0.30,
    orca: 0.25,
    meteora: 0.20,
    kamino: 0.15,
    idle_usdc: 0.10,
  };

  // Minimum drift before triggering rebalance (saves gas on small deviations)
  private readonly REBALANCE_THRESHOLD = 0.07; // 7% drift

  constructor(deps: AgentDependencies) {
    super("rebalancer", deps);
  }

  protected getRoleDescription(): string {
    return `You are a portfolio rebalancing specialist. You maintain optimal allocation 
across DeFi protocols by identifying when portfolio drift creates risk or cost inefficiency. 
You are methodical and cost-conscious — you calculate exact break-even periods before 
recommending any rebalance. You compound rewards efficiently and keep gas costs minimal.`;
  }

  protected async onStart(): Promise<void> {
    this.logger.info("Rebalancer initialized — tracking allocation targets");
  }

  protected async registerSubscriptions(): Promise<void> {
    this.bus.subscribe(CHANNELS.PORTFOLIO_UPDATE, async (msg) => {
      this.latestPortfolio = msg.payload as Portfolio;
      await this.checkDriftAndPropose();
    });

    this.bus.subscribe(CHANNELS.POOL_DATA_UPDATE, async (msg) => {
      this.latestPoolData = msg.payload as PoolData[];
    });

    // Vote on proposals from a portfolio-health perspective
    this.bus.subscribe(CHANNELS.PROPOSAL_NEW, async (msg) => {
      const proposal = msg.payload as AgentProposal;
      if (proposal.agentId === this.id) return;
      await this.votePortfolioHealth(proposal);
    });
  }

  protected async onSignal(signal: Signal): Promise<void> {
    const relevantTypes: Signal["type"][] = ["rebalance_due", "apy_collapse"];
    if (!relevantTypes.includes(signal.type)) return;

    this.logger.info({ signalId: signal.id, type: signal.type }, "Rebalancer responding to signal");
    await this.checkDriftAndPropose(signal);
  }

  // ── Core logic ────────────────────────────────────────────────────────────

  private async checkDriftAndPropose(signal?: Signal): Promise<void> {
    const portfolio = this.latestPortfolio;
    if (!portfolio || portfolio.totalValueUsd < 100) return;

    const opportunities = await this.findOpportunities(portfolio);

    if (opportunities.length === 0) {
      this.logger.debug("No rebalancing needed");
      return;
    }

    // Sort by net benefit, highest first
    opportunities.sort((a, b) => b.netBenefit - a.netBenefit);

    // Only propose the best opportunity per cycle to avoid flooding the bus
    const best = opportunities[0];
    if (!best || best.netBenefit < 1) {
      this.logger.debug({ netBenefit: best?.netBenefit }, "Best opportunity not worth the cost");
      return;
    }

    const aiReasoning = await this.generateReasoning(best, portfolio);

    await this.submitProposal({
      signalId: signal?.id ?? `rebalancer-scheduled-${Date.now()}`,
      action: best.action,
      reasoning: aiReasoning,
      confidence: this.calculateConfidence(best),
      expectedReturnUsd: best.estimatedGainUsd,
      maxDownsideUsd: best.estimatedCostUsd * 3, // Conservative 3x cost as downside
      estimatedGasLamports: 8_000,
      urgency: best.urgency,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  }

  private async findOpportunities(portfolio: Portfolio): Promise<RebalanceOpportunity[]> {
    const opportunities: RebalanceOpportunity[] = [];

    // 1. Allocation drift correction
    const driftOpps = this.findDriftOpportunities(portfolio);
    opportunities.push(...driftOpps);

    // 2. Reward harvesting (if unclaimed rewards > gas cost)
    const harvestOpp = this.findHarvestOpportunity(portfolio);
    if (harvestOpp) opportunities.push(harvestOpp);

    // 3. Fee tier optimization (CLMM position out of range)
    const feeOpp = this.findFeeOptimizationOpportunity(portfolio);
    if (feeOpp) opportunities.push(feeOpp);

    return opportunities.filter((o) => o.netBenefit > 0);
  }

  private findDriftOpportunities(portfolio: Portfolio): RebalanceOpportunity[] {
    const opportunities: RebalanceOpportunity[] = [];

    // Calculate current allocation by protocol
    const currentAllocation = new Map<string, number>();
    for (const position of portfolio.positions) {
      const current = currentAllocation.get(position.protocol) ?? 0;
      currentAllocation.set(position.protocol, current + position.valueUsd);
    }

    // Add idle USDC
    currentAllocation.set("idle_usdc", portfolio.idleUsdc);

    for (const [protocol, targetPct] of Object.entries(this.targetAllocations)) {
      const actualUsd = currentAllocation.get(protocol) ?? 0;
      const actualPct = actualUsd / portfolio.totalValueUsd;
      const driftPct = Math.abs(actualPct - targetPct);

      if (driftPct < this.REBALANCE_THRESHOLD) continue;

      const targetUsd = portfolio.totalValueUsd * targetPct;
      const deltaBigger = actualUsd > targetUsd; // We have too much here

      if (deltaBigger) {
        // Over-allocated — need to reduce
        const excessUsd = actualUsd - targetUsd;
        const fractionToMove = excessUsd / actualUsd;

        // Find the most under-allocated protocol to move into
        const underAllocated = Object.entries(this.targetAllocations)
          .filter(([p]) => p !== protocol)
          .map(([p, tgt]) => ({
            protocol: p,
            deficit: tgt - (currentAllocation.get(p) ?? 0) / portfolio.totalValueUsd,
          }))
          .sort((a, b) => b.deficit - a.deficit)[0];

        if (underAllocated && underAllocated.deficit > 0) {
          const overProtocol = portfolio.positions.find((p) => p.protocol === protocol);
          if (!overProtocol) continue;

          const gasCostUsd = 0.002; // ~0.002 SOL in gas at current prices
          const breakEvenDays = gasCostUsd / ((overProtocol.currentApy / 365 / 100) * excessUsd + 0.0001);

          const destPool = this.findBestPoolAddress(
            underAllocated.protocol,
            overProtocol.poolAddress
          );

          opportunities.push({
            type: "drift_correction",
            description: `${protocol} over-allocated by ${(driftPct * 100).toFixed(1)}% — rotate ${excessUsd.toFixed(0)} to ${underAllocated.protocol}`,
            estimatedGainUsd: excessUsd * (overProtocol.currentApy / 100 / 365) * 30,
            estimatedCostUsd: gasCostUsd,
            netBenefit: excessUsd * 0.01 - gasCostUsd,
            urgency: driftPct > 0.15 ? "high" : "medium",
            action: {
              type: "rebalance",
              params: {
                fromPool: overProtocol.poolAddress,
                toPool: destPool,
                fromProtocol: protocol as never,
                toProtocol: underAllocated.protocol as never,
                fraction: Math.min(fractionToMove, 0.5),
                reason: `Drift correction: ${protocol} ${(driftPct * 100).toFixed(1)}% over target`,
                estimatedApyGain: 2,
                estimatedCostBps: 15,
              },
            },
          });
        }
      }
    }

    return opportunities;
  }

  private findHarvestOpportunity(portfolio: Portfolio): RebalanceOpportunity | null {
    // Harvest if unclaimed rewards > $5 (rough threshold to cover gas)
    const totalPendingRewards = portfolio.positions.reduce((sum, p) => {
      const dailyReward = (p.valueUsd * p.currentApy) / 100 / 365;
      const daysSinceHarvest = 1; // Would track real time in production
      return sum + dailyReward * daysSinceHarvest;
    }, 0);

    if (totalPendingRewards < 5) return null;

    return {
      type: "reward_harvest",
      description: `Harvest ~$${totalPendingRewards.toFixed(2)} in pending rewards and compound`,
      estimatedGainUsd: totalPendingRewards,
      estimatedCostUsd: 0.003,
      netBenefit: totalPendingRewards - 0.003,
      urgency: "low",
      action: {
        type: "harvest_rewards",
        params: { positions: portfolio.positions.map((p) => p.id) },
      },
    };
  }

  private findFeeOptimizationOpportunity(portfolio: Portfolio): RebalanceOpportunity | null {
    // Check if any CLMM positions are out of range (earning 0 fees)
    const outOfRange = portfolio.positions.filter((p) => p.currentApy === 0 && p.valueUsd > 100);
    if (outOfRange.length === 0) return null;

    const totalStuckValue = outOfRange.reduce((s, p) => s + p.valueUsd, 0);

    const fromPos = outOfRange[0]!;
    const bestInRange = this.findBestPoolAddress(fromPos.protocol, fromPos.poolAddress);

    return {
      type: "fee_optimization",
      description: `${outOfRange.length} position(s) out of range, $${totalStuckValue.toFixed(0)} earning 0% — reposition`,
      estimatedGainUsd: (totalStuckValue * 0.3) / 365 * 30,
      estimatedCostUsd: 0.005 * outOfRange.length,
      netBenefit: totalStuckValue * 0.005 - 0.005 * outOfRange.length,
      urgency: "medium",
      action: {
        type: "rebalance",
        params: {
          fromPool: fromPos.poolAddress,
          toPool: bestInRange,
          fromProtocol: fromPos.protocol as never,
          toProtocol: fromPos.protocol as never,
          fraction: 1.0,
          reason: "CLMM position out of range — repositioning",
          estimatedApyGain: 30,
          estimatedCostBps: 20,
        },
      },
    };
  }

  // ── Pool resolution ───────────────────────────────────────────────────────

  private findBestPoolAddress(
    preferProtocol: string,
    excludePool?: string
  ): string {
    const candidates = this.latestPoolData
      .filter(
        (p) =>
          p.protocol === preferProtocol &&
          p.tvlUsd > 100_000 &&
          p.apyTotal > 0 &&
          p.address !== excludePool
      )
      .sort((a, b) => b.apyTotal - a.apyTotal);

    // Fall back to any protocol if preferred has nothing
    if (candidates.length === 0) {
      const any = this.latestPoolData
        .filter((p) => p.tvlUsd > 100_000 && p.apyTotal > 0 && p.address !== excludePool)
        .sort((a, b) => b.apyTotal - a.apyTotal)[0];
      return any?.address ?? "best-available";
    }

    return candidates[0]!.address;
  }

  // ── AI reasoning ──────────────────────────────────────────────────────────

  private async generateReasoning(
    opportunity: RebalanceOpportunity,
    portfolio: Portfolio
  ): Promise<string> {
    const prompt = `
REBALANCING OPPORTUNITY:
Type: ${opportunity.type}
Description: ${opportunity.description}
Estimated gain: $${opportunity.estimatedGainUsd.toFixed(2)} over 30 days
Estimated cost: $${opportunity.estimatedCostUsd.toFixed(4)}
Net benefit: $${opportunity.netBenefit.toFixed(2)}

PORTFOLIO CONTEXT:
Total value: $${portfolio.totalValueUsd.toFixed(2)}
Positions: ${portfolio.positions.length}
Daily return: ${(portfolio.dailyReturnPct * 100).toFixed(3)}%

Write a concise 2-3 sentence justification for this rebalancing action.
Focus on: why now, what the gain is, what the risk is if we don't act.
Be specific with numbers. No jargon. Write for a non-technical audience.
`.trim();

    return this.think("Respond in plain text, 2-3 sentences, no headers or bullets.", prompt, 256);
  }

  private calculateConfidence(opportunity: RebalanceOpportunity): number {
    const roi = opportunity.netBenefit / (opportunity.estimatedCostUsd + 0.001);
    if (roi > 100) return 0.88;
    if (roi > 50) return 0.78;
    if (roi > 10) return 0.68;
    return 0.58;
  }

  // ── Voting ────────────────────────────────────────────────────────────────

  private async votePortfolioHealth(proposal: AgentProposal): Promise<void> {
    const portfolio = this.latestPortfolio;
    if (!portfolio) {
      await this.castVote({
        proposalId: proposal.id,
        decision: "abstain",
        confidence: 0.5,
        reasoning: "No portfolio data",
      });
      return;
    }

    // Check if this action improves or harms portfolio health
    let decision: "approve" | "reject" | "abstain" = "approve";
    let reasoning = "Action aligns with portfolio optimization goals";

    const action = proposal.action;

    if (action.type === "rebalance") {
      // Check if the destination improves allocation
      const targetProtocol = action.params.toProtocol;
      const targetAlloc = this.targetAllocations[targetProtocol] ?? 0;
      const currentProtocolUsd = portfolio.positions
        .filter((p) => p.protocol === targetProtocol)
        .reduce((s, p) => s + p.valueUsd, 0);
      const currentAlloc = currentProtocolUsd / portfolio.totalValueUsd;

      if (currentAlloc > targetAlloc + 0.15) {
        decision = "reject";
        reasoning = `${targetProtocol} already at ${(currentAlloc * 100).toFixed(0)}% vs target ${(targetAlloc * 100).toFixed(0)}% — would increase concentration`;
      }
    }

    if (action.type === "emergency_exit") {
      // Always support emergency exits
      decision = "approve";
      reasoning = "Supporting emergency exit to protect portfolio";
    }

    await this.castVote({
      proposalId: proposal.id,
      decision,
      confidence: 0.75,
      reasoning,
    });
  }
}
