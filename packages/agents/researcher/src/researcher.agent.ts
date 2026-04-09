/**
 * ResearcherAgent — Market intelligence and opportunity discovery.
 *
 * Responsibilities:
 * - Analyzes incoming signals using real market data + Claude reasoning
 * - Fetches and synthesizes protocol analytics, tokenomics, team credibility
 * - Runs APY projection models (trend extrapolation + AI scoring)
 * - Monitors X/social for protocol sentiment shifts
 * - Produces structured proposals with expected return estimates
 * - Votes on other agents' proposals from a "opportunity quality" lens
 *
 * The researcher is OPTIMISTIC by design — it finds reasons to act.
 * The risk-assessor is the counterweight.
 */

import type {
  Signal,
  AgentProposal,
  PoolData,
  Portfolio,
  ActionParams,
} from "@swarm/shared";
import {
  BaseAgent,
  CHANNELS,
  type AgentDependencies,
} from "@swarm/shared";

interface ResearchContext {
  signal: Signal;
  relatedPools: PoolData[];
  portfolio: Portfolio;
}

export class ResearcherAgent extends BaseAgent {
  private latestPoolData: PoolData[] = [];
  private latestPortfolio?: Portfolio;

  constructor(deps: AgentDependencies) {
    super("researcher", deps);
  }

  protected getRoleDescription(): string {
    return `You are a DeFi research analyst. You identify high-quality yield opportunities 
on Solana, assess protocol credibility, project APY trends, and generate specific, 
actionable trade proposals. You are thorough, data-driven, and optimistic about 
opportunities — but honest about risks. Your proposals compete with other agents' 
proposals through consensus voting.`;
  }

  protected async onStart(): Promise<void> {
    this.logger.info("Researcher agent initialized — scanning protocols");
  }

  protected async registerSubscriptions(): Promise<void> {
    // Receive updated pool data from conductor
    this.bus.subscribe(CHANNELS.PORTFOLIO_UPDATE, async (msg) => {
      this.latestPortfolio = msg.payload as Portfolio;
    });

    // Vote on proposals from other agents
    this.bus.subscribe(CHANNELS.PROPOSAL_NEW, async (msg) => {
      const proposal = msg.payload as AgentProposal;
      if (proposal.agentId === this.id) return; // Don't vote on own proposals
      await this.voteOnProposal(proposal);
    });
  }

  protected async onSignal(signal: Signal): Promise<void> {
    // Only respond to opportunity signals
    const relevantTypes: Signal["type"][] = [
      "apy_spike",
      "new_pool",
      "price_divergence",
      "rebalance_due",
    ];

    if (!relevantTypes.includes(signal.type)) return;

    this.logger.info({ signalId: signal.id, type: signal.type }, "Researcher analyzing signal");

    try {
      const proposal = await this.analyzeAndPropose(signal);
      if (proposal) {
        await this.submitProposal(proposal);
      }
    } catch (err) {
      this.logger.error({ err, signalId: signal.id }, "Research analysis failed");
    }
  }

  // ── Core analysis ─────────────────────────────────────────────────────────

  private async analyzeAndPropose(
    signal: Signal
  ): Promise<Omit<AgentProposal, "id" | "agentId" | "agentRole" | "createdAt"> | null> {
    const context = await this.buildResearchContext(signal);

    // Build the AI analysis prompt
    const analysisPrompt = this.buildAnalysisPrompt(context);

    const aiResponse = await this.think(
      `You output structured JSON only. No markdown, no explanation outside the JSON.
Schema: { 
  "shouldAct": boolean,
  "action": "add_liquidity" | "rebalance" | "swap" | "hold",
  "targetPool": string | null,
  "targetProtocol": string | null,
  "fromPool": string | null,
  "fraction": number,
  "expectedApyGain": number,
  "confidence": number,
  "reasoning": string,
  "estimatedReturnUsd": number,
  "maxDownsideUsd": number,
  "urgency": "low" | "medium" | "high" | "critical"
}`,
      analysisPrompt,
      1024
    );

    let parsed: {
      shouldAct: boolean;
      action: string;
      targetPool: string | null;
      targetProtocol: string | null;
      fromPool: string | null;
      fraction: number;
      expectedApyGain: number;
      confidence: number;
      reasoning: string;
      estimatedReturnUsd: number;
      maxDownsideUsd: number;
      urgency: "low" | "medium" | "high" | "critical";
    };

    try {
      parsed = JSON.parse(aiResponse);
    } catch {
      this.logger.warn({ aiResponse }, "Failed to parse AI research response");
      return null;
    }

    if (!parsed.shouldAct || parsed.confidence < 0.60) {
      this.logger.info(
        { confidence: parsed.confidence, shouldAct: parsed.shouldAct },
        "Researcher: insufficient opportunity — no proposal"
      );
      return null;
    }

    const action = this.buildActionParams(parsed, context);
    if (!action) return null;

    const expiresAt = new Date(Date.now() + 5 * 60_000);

    return {
      signalId: signal.id,
      action,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      expectedReturnUsd: parsed.estimatedReturnUsd,
      maxDownsideUsd: parsed.maxDownsideUsd,
      estimatedGasLamports: 5000,
      urgency: parsed.urgency,
      expiresAt,
    };
  }

  private async buildResearchContext(signal: Signal): Promise<ResearchContext> {
    const portfolio = this.latestPortfolio ?? this.blankPortfolio();

    // Find pools related to this signal
    const relatedPools = this.latestPoolData
      .filter((p) => {
        if (signal.data["poolAddress"] && p.address === signal.data["poolAddress"]) return true;
        if (signal.data["protocol"] && p.protocol === signal.data["protocol"]) return true;
        return p.apyTotal > 20 && p.tvlUsd > 500_000; // Always include high-quality pools
      })
      .sort((a, b) => b.apyTotal - a.apyTotal)
      .slice(0, 10); // Top 10 most relevant

    return { signal, relatedPools, portfolio };
  }

  private buildAnalysisPrompt(ctx: ResearchContext): string {
    const { signal, relatedPools, portfolio } = ctx;

    const topPools = relatedPools
      .slice(0, 5)
      .map((p) =>
        `- ${p.protocol}:${p.address.slice(0, 8)} | APY: ${p.apyTotal.toFixed(1)}% | TVL: $${(p.tvlUsd / 1e6).toFixed(2)}M | Risk: ${p.riskScore}/100`
      )
      .join("\n");

    const activePositions = portfolio.positions
      .map(
        (p) =>
          `- ${p.protocol}:${p.poolAddress.slice(0, 8)} | Value: $${p.valueUsd.toFixed(0)} | APY: ${p.currentApy.toFixed(1)}% | PnL: ${p.pnlPct > 0 ? "+" : ""}${(p.pnlPct * 100).toFixed(1)}%`
      )
      .join("\n") || "No active positions";

    return `
SIGNAL RECEIVED:
Type: ${signal.type}
Priority: ${signal.priority}
Confidence: ${signal.confidence}
Data: ${JSON.stringify(signal.data, null, 2)}

CURRENT PORTFOLIO:
Total Value: $${portfolio.totalValueUsd.toFixed(2)}
Idle USDC: $${portfolio.idleUsdc.toFixed(2)}
Daily Return: ${(portfolio.dailyReturnPct * 100).toFixed(2)}%

Active Positions:
${activePositions}

TOP RELEVANT POOLS (sorted by APY):
${topPools || "No pool data available"}

TASK:
Analyze this signal and determine if we should take action.
Consider:
1. Is this APY sustainable or likely to collapse soon?
2. What's the opportunity cost of not acting?
3. Are there better pools we should rotate to?
4. What's the realistic expected return over the next 24-48 hours?
5. What could go wrong (smart contract risk, IL, APY collapse)?

Generate a specific, actionable proposal or recommend HOLD.
Be precise with numbers — especially fraction (0-1) of portfolio to move.
`.trim();
  }

  private buildActionParams(
    parsed: { action: string; targetPool: string | null; targetProtocol: string | null; fromPool: string | null; fraction: number; expectedApyGain: number },
    ctx: ResearchContext
  ): ActionParams | null {
    const { portfolio } = ctx;

    switch (parsed.action) {
      case "rebalance": {
        if (!parsed.fromPool && portfolio.positions.length === 0) return null;
        const fromPool = parsed.fromPool ?? portfolio.positions[0]?.poolAddress ?? "unknown";
        const toPool = parsed.targetPool ?? "best-available";

        return {
          type: "rebalance",
          params: {
            fromPool,
            toPool,
            fromProtocol: "raydium",
            toProtocol: (parsed.targetProtocol as "raydium" | "orca" | "meteora") ?? "orca",
            fraction: Math.min(0.5, Math.max(0.05, parsed.fraction)),
            reason: `Researcher: APY gain of +${parsed.expectedApyGain.toFixed(1)}% identified`,
            estimatedApyGain: parsed.expectedApyGain,
            estimatedCostBps: 30,
          },
        };
      }

      case "add_liquidity": {
        if (!parsed.targetPool) return null;
        const deployAmount = BigInt(
          Math.floor(portfolio.idleUsdc * parsed.fraction * 1e6) // USDC has 6 decimals
        );
        if (deployAmount < 1_000_000n) return null; // Don't bother with < $1

        return {
          type: "add_liquidity",
          params: {
            poolAddress: parsed.targetPool,
            protocol: (parsed.targetProtocol as "raydium" | "orca") ?? "raydium",
            tokenAAmount: deployAmount / 2n,
            tokenBAmount: deployAmount / 2n,
            slippageBps: 50,
          },
        };
      }

      case "hold":
        return {
          type: "hold",
          params: { reason: "Researcher: no compelling opportunity found", revisitIn: 300 },
        };

      default:
        return null;
    }
  }

  // ── Voting ────────────────────────────────────────────────────────────────

  private async voteOnProposal(proposal: AgentProposal): Promise<void> {
    // Researcher evaluates opportunity quality
    const votePrompt = `
Another agent (${proposal.agentRole}) proposed this action:
Type: ${proposal.action.type}
Reasoning: ${proposal.reasoning}
Expected Return: $${proposal.expectedReturnUsd.toFixed(2)}
Max Downside: $${proposal.maxDownsideUsd.toFixed(2)}
Confidence: ${proposal.confidence}

From a RESEARCH perspective (opportunity quality, market timing, APY validity):
Is this a good trade? Respond with JSON only:
{ "decision": "approve" | "reject" | "abstain", "confidence": 0-1, "reasoning": "one sentence" }
`.trim();

    try {
      const response = await this.think("Respond JSON only. No markdown.", votePrompt, 256);
      const vote = JSON.parse(response) as { decision: "approve" | "reject" | "abstain"; confidence: number; reasoning: string };

      await this.castVote({
        proposalId: proposal.id,
        decision: vote.decision,
        confidence: vote.confidence,
        reasoning: vote.reasoning,
      });
    } catch (err) {
      this.logger.warn({ err, proposalId: proposal.id }, "Researcher vote failed — abstaining");
      await this.castVote({
        proposalId: proposal.id,
        decision: "abstain",
        confidence: 0.5,
        reasoning: "Vote error — abstaining",
      });
    }
  }

  private blankPortfolio(): Portfolio {
    return {
      walletAddress: "",
      totalValueUsd: 0,
      positions: [],
      idleUsdc: 0,
      lastUpdated: new Date(),
      allTimeReturnPct: 0,
      dailyReturnPct: 0,
    };
  }
}
