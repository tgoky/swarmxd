/**
 * RiskAssessorAgent — The devil's advocate.
 *
 * This agent is PESSIMISTIC by design. Its job is to find every way
 * a proposed action could go wrong and quantify the downside precisely.
 *
 * Responsibilities:
 * - Smart contract risk assessment (audit history, TVL age, team reputation)
 * - Impermanent loss modeling at different price scenarios
 * - Liquidity depth analysis (can we exit without major slippage?)
 * - Correlation risk (are all our positions moving together?)
 * - Protocol concentration risk
 * - On-chain anomaly detection (unusual transactions pre-signal)
 *
 * CRITICAL: Risk assessor votes have 1.5x weight in consensus.
 * A strong reject from risk assessor can block a proposal even if 
 * researcher + rebalancer both approve.
 */

import type {
  Signal,
  AgentProposal,
  Portfolio,
  PoolData,
} from "@swarm/shared";
import {
  BaseAgent,
  CHANNELS,
  type AgentDependencies,
} from "@swarm/shared";

interface RiskReport {
  overallScore: number;     // 0-100, higher = riskier
  smartContractRisk: number;
  liquidityRisk: number;
  impermanentLossRisk: number;
  concentrationRisk: number;
  marketRisk: number;
  redFlags: string[];
  mitigations: string[];
}

export class RiskAssessorAgent extends BaseAgent {
  private latestPoolData: PoolData[] = [];
  private latestPortfolio?: Portfolio;

  constructor(deps: AgentDependencies) {
    super("risk-assessor", deps);
  }

  protected getRoleDescription(): string {
    return `You are a DeFi risk analyst. Your job is to identify every way a trade 
can go wrong and quantify the downside precisely. You are deliberately pessimistic — 
you assume smart contracts can fail, prices can move against us, and liquidity can 
vanish. You protect the portfolio from catastrophic loss. Your votes carry 1.5x weight.
When in doubt, REJECT.`;
  }

  protected async onStart(): Promise<void> {
    this.logger.info("Risk assessor initialized — threat models loaded");
  }

  protected async registerSubscriptions(): Promise<void> {
    this.bus.subscribe(CHANNELS.PORTFOLIO_UPDATE, async (msg) => {
      this.latestPortfolio = msg.payload as Portfolio;
    });

    // Risk assessor votes on ALL proposals
    this.bus.subscribe(CHANNELS.PROPOSAL_NEW, async (msg) => {
      const proposal = msg.payload as AgentProposal;
      if (proposal.agentId === this.id) return;
      await this.assessAndVote(proposal);
    });
  }

  protected async onSignal(signal: Signal): Promise<void> {
    // Risk assessor responds to RISK signals — it doesn't propose trades,
    // but it can propose emergency exits
    const riskSignals: Signal["type"][] = [
      "risk_alert",
      "liquidity_drain",
      "apy_collapse",
      "emergency_exit",
    ];

    if (!riskSignals.includes(signal.type)) return;

    this.logger.warn({ signalId: signal.id, type: signal.type }, "⚠️ Risk signal — evaluating");

    if (signal.type === "emergency_exit" || signal.type === "liquidity_drain") {
      await this.proposeEmergencyExit(signal);
    }
  }

  // ── Risk assessment ───────────────────────────────────────────────────────

  private async assessAndVote(proposal: AgentProposal): Promise<void> {
    const portfolio = this.latestPortfolio;
    if (!portfolio) {
      await this.castVote({
        proposalId: proposal.id,
        decision: "abstain",
        confidence: 0.5,
        reasoning: "No portfolio data available — abstaining",
      });
      return;
    }

    const riskReport = await this.buildRiskReport(proposal, portfolio);
    const voteDecision = await this.makeVoteDecision(proposal, riskReport);

    await this.castVote({
      proposalId: proposal.id,
      decision: voteDecision.decision,
      confidence: voteDecision.confidence,
      reasoning: voteDecision.reasoning,
    });

    this.logger.info(
      {
        proposalId: proposal.id,
        decision: voteDecision.decision,
        riskScore: riskReport.overallScore,
        redFlags: riskReport.redFlags.length,
      },
      "Risk assessment complete"
    );
  }

  private async buildRiskReport(
    proposal: AgentProposal,
    portfolio: Portfolio
  ): Promise<RiskReport> {
    const action = proposal.action;

    // Smart contract risk: based on protocol age + TVL + audit status
    const smartContractRisk = this.scoreSmartContractRisk(action);

    // Liquidity risk: can we exit this position?
    const liquidityRisk = this.scoreLiquidityRisk(action);

    // IL risk: how exposed are we to divergence loss?
    const ilRisk = this.scoreImpermanentLossRisk(action);

    // Concentration risk: are we putting too many eggs in one basket?
    const concentrationRisk = this.scoreConcentrationRisk(action, portfolio);

    // Market risk: macro conditions, volatility
    const marketRisk = 40; // Baseline; would use real vol data in production

    const overallScore = Math.round(
      smartContractRisk * 0.25 +
        liquidityRisk * 0.20 +
        ilRisk * 0.20 +
        concentrationRisk * 0.20 +
        marketRisk * 0.15
    );

    const redFlags: string[] = [];
    const mitigations: string[] = [];

    if (smartContractRisk > 70) redFlags.push("Protocol lacks recent security audit");
    if (liquidityRisk > 65) redFlags.push("Insufficient liquidity depth for clean exit");
    if (ilRisk > 70) redFlags.push("High IL risk due to asset volatility divergence");
    if (concentrationRisk > 60) redFlags.push("Portfolio concentration too high post-trade");
    if (proposal.maxDownsideUsd > portfolio.totalValueUsd * 0.10)
      redFlags.push(`Max downside $${proposal.maxDownsideUsd.toFixed(0)} is >10% of portfolio`);

    if (concentrationRisk > 50) mitigations.push("Reduce position size by 50%");
    if (liquidityRisk > 50) mitigations.push("Set strict stop-loss order");
    if (ilRisk > 60) mitigations.push("Choose correlated pair (e.g., SOL-mSOL) to minimize IL");

    return {
      overallScore,
      smartContractRisk,
      liquidityRisk,
      impermanentLossRisk: ilRisk,
      concentrationRisk,
      marketRisk,
      redFlags,
      mitigations,
    };
  }

  private async makeVoteDecision(
    proposal: AgentProposal,
    riskReport: RiskReport
  ): Promise<{ decision: "approve" | "reject" | "abstain"; confidence: number; reasoning: string }> {
    const votePrompt = `
PROPOSAL TO ASSESS:
Action: ${proposal.action.type}
Reasoning from proposing agent: ${proposal.reasoning}
Expected return: $${proposal.expectedReturnUsd.toFixed(2)}
Max downside: $${proposal.maxDownsideUsd.toFixed(2)}
Proposer confidence: ${proposal.confidence}

RISK ASSESSMENT RESULTS:
Overall Risk Score: ${riskReport.overallScore}/100 (higher = riskier)
Smart Contract Risk: ${riskReport.smartContractRisk}/100
Liquidity Risk: ${riskReport.liquidityRisk}/100
Impermanent Loss Risk: ${riskReport.impermanentLossRisk}/100
Concentration Risk: ${riskReport.concentrationRisk}/100
Market Risk: ${riskReport.marketRisk}/100

Red Flags (${riskReport.redFlags.length}):
${riskReport.redFlags.map((f) => `- ${f}`).join("\n") || "None"}

Suggested Mitigations:
${riskReport.mitigations.map((m) => `- ${m}`).join("\n") || "None"}

DECISION CRITERIA:
- Risk score 0-40: Likely approve (good risk/reward)
- Risk score 41-60: Needs strong expected return to justify
- Risk score 61-75: Reject unless return is exceptional
- Risk score 76+: Always reject

Your vote carries 1.5x weight. Be the guardian of portfolio safety.
Respond with JSON only:
{ "decision": "approve" | "reject" | "abstain", "confidence": 0.0-1.0, "reasoning": "one or two sentences max" }
`.trim();

    try {
      const response = await this.think("Respond JSON only. No markdown.", votePrompt, 256);
      const vote = JSON.parse(response) as {
        decision: "approve" | "reject" | "abstain";
        confidence: number;
        reasoning: string;
      };

      // Hard override: if risk score >= 80, always reject regardless of AI
      if (riskReport.overallScore >= 80) {
        return {
          decision: "reject",
          confidence: 0.95,
          reasoning: `Hard reject: risk score ${riskReport.overallScore}/100 exceeds safety threshold`,
        };
      }

      return vote;
    } catch {
      return {
        decision: "abstain",
        confidence: 0.5,
        reasoning: "Vote parsing failed — abstaining",
      };
    }
  }

  // ── Emergency exit proposal ────────────────────────────────────────────────

  private async proposeEmergencyExit(signal: Signal): Promise<void> {
    const portfolio = this.latestPortfolio;
    if (!portfolio || portfolio.positions.length === 0) return;

    const affectedPool = signal.data["poolAddress"] as string | undefined;
    const affectedPositions = affectedPool
      ? portfolio.positions.filter((p) => p.poolAddress === affectedPool).map((p) => p.id)
      : portfolio.positions.map((p) => p.id);

    if (affectedPositions.length === 0) return;

    const totalAtRisk = portfolio.positions
      .filter((p) => affectedPositions.includes(p.id))
      .reduce((sum, p) => sum + p.valueUsd, 0);

    await this.submitProposal({
      signalId: signal.id,
      action: {
        type: "emergency_exit",
        params: {
          positions: affectedPositions,
          reason: `Risk assessor: ${signal.type} — ${JSON.stringify(signal.data)}`,
        },
      },
      reasoning: `Emergency exit triggered by ${signal.type} signal. ${affectedPositions.length} positions at risk, total value $${totalAtRisk.toFixed(0)}.`,
      confidence: 0.92,
      expectedReturnUsd: 0,
      maxDownsideUsd: totalAtRisk,
      estimatedGasLamports: 10_000 * affectedPositions.length,
      urgency: "critical",
      expiresAt: new Date(Date.now() + 60_000), // 60s to exit
    });
  }

  // ── Scoring heuristics ────────────────────────────────────────────────────

  private scoreSmartContractRisk(action: AgentProposal["action"]): number {
    // In production: lookup protocol audit DB, TVL age, incident history
    const protocolRiskMap: Record<string, number> = {
      raydium: 25,    // Audited, long track record
      orca: 20,       // Conservative, audited
      meteora: 40,    // Newer, less battle-tested
      lifinity: 50,   // Market maker model, more complex
      kamino: 35,     // Audited but newer
      drift: 40,      // Perp protocol, higher complexity
      mango: 55,      // Historical exploit
      jupiter: 15,    // Aggregator, very battle-tested
      whirlpool: 20,  // Orca's CLMM, audited
    };

    if (action.type === "rebalance") {
      const toProtocol = action.params.toProtocol;
      return protocolRiskMap[toProtocol] ?? 60;
    }
    if (action.type === "add_liquidity") {
      const protocol = action.params.protocol;
      return protocolRiskMap[protocol] ?? 60;
    }
    return 30;
  }

  private scoreLiquidityRisk(action: AgentProposal["action"]): number {
    // Low TVL = hard to exit without major slippage
    // Would use real depth data in production
    if (action.type === "rebalance") {
      const fraction = action.params.fraction;
      return fraction > 0.3 ? 60 : 30; // Moving > 30% of portfolio = liquidity risk
    }
    return 35;
  }

  private scoreImpermanentLossRisk(action: AgentProposal["action"]): number {
    // Correlated pairs (SOL/mSOL, USDC/USDT) have low IL risk
    // Volatile pairs (SOL/BONK) have high IL risk
    if (action.type === "add_liquidity" || action.type === "rebalance") {
      // Would check actual token pair correlation in production
      return 45; // Moderate default
    }
    return 20;
  }

  private scoreConcentrationRisk(
    action: AgentProposal["action"],
    portfolio: Portfolio
  ): number {
    if (portfolio.totalValueUsd === 0) return 50;

    if (action.type === "rebalance" || action.type === "add_liquidity") {
      // Check if this trade would create > 40% concentration in one pool
      const estimatedNewPosition = portfolio.totalValueUsd * 0.2; // rough
      const maxExisting = Math.max(...portfolio.positions.map((p) => p.valueUsd), 0);
      const postTradeMax = Math.max(maxExisting, estimatedNewPosition);
      const concentration = postTradeMax / portfolio.totalValueUsd;

      if (concentration > 0.5) return 80;
      if (concentration > 0.35) return 55;
      return 25;
    }

    return 20;
  }
}
