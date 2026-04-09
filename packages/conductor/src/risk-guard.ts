/**
 * RiskGuard — Non-negotiable hard stops.
 *
 * These rules CANNOT be overridden by consensus, AI reasoning, or human input.
 * If the risk guard says no, the action is blocked, period.
 *
 * Design principle: The risk guard is dumb on purpose.
 * It doesn't use AI or complex logic — it uses simple math.
 * "Can we lose more than X?" If yes, block.
 */

import type { SwarmConfig, Portfolio, AgentProposal, ActionParams } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

export class RiskGuard {
  constructor(
    private readonly config: SwarmConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Check if portfolio has hit the stop-loss threshold.
   * Returns a reason string if halted, null if OK.
   */
  checkStopLoss(portfolio: Portfolio): string | null {
    const drawdown = portfolio.allTimeReturnPct < 0 ? Math.abs(portfolio.allTimeReturnPct) : 0;

    if (drawdown >= this.config.risk.stopLossPct) {
      return `All-time drawdown ${(drawdown * 100).toFixed(1)}% >= stop-loss ${(this.config.risk.stopLossPct * 100).toFixed(1)}%`;
    }

    const dailyDrawdown = portfolio.dailyReturnPct < 0 ? Math.abs(portfolio.dailyReturnPct) : 0;
    const dailyStopLoss = this.config.risk.stopLossPct * 0.5; // 50% of all-time SL for daily

    if (dailyDrawdown >= dailyStopLoss) {
      return `Daily drawdown ${(dailyDrawdown * 100).toFixed(1)}% >= daily stop-loss ${(dailyStopLoss * 100).toFixed(1)}%`;
    }

    return null;
  }

  /**
   * Final veto check before execution — even after consensus passes.
   * Returns veto reason string, or null if clean.
   */
  vetoCheck(proposal: AgentProposal, portfolio: Portfolio): string | null {
    const action = proposal.action;

    // Rule 1: Absolute portfolio cap
    if (portfolio.totalValueUsd > this.config.risk.maxPortfolioValueUsd) {
      return `Portfolio value $${portfolio.totalValueUsd.toFixed(0)} exceeds max $${this.config.risk.maxPortfolioValueUsd}`;
    }

    // Rule 2: Max single trade size
    if (action.type !== "hold" && action.type !== "harvest_rewards") {
      const tradeValueUsd = this.estimateTradeValue(action, portfolio);
      const maxTradeUsd = portfolio.totalValueUsd * this.config.risk.maxTradeSizePct;

      if (tradeValueUsd > maxTradeUsd) {
        return `Trade size $${tradeValueUsd.toFixed(0)} exceeds max ${(this.config.risk.maxTradeSizePct * 100).toFixed(0)}% = $${maxTradeUsd.toFixed(0)}`;
      }
    }

    // Rule 3: Slippage guard (executor sets actual slippage, but proposal can flag)
    if (action.type === "swap" && action.params.slippageBps > this.config.risk.maxSlippageBps) {
      return `Swap slippage ${action.params.slippageBps}bps > max ${this.config.risk.maxSlippageBps}bps`;
    }

    // Rule 4: Max downside absolute cap
    if (proposal.maxDownsideUsd > portfolio.totalValueUsd * 0.15) {
      return `Max downside $${proposal.maxDownsideUsd.toFixed(0)} > 15% of portfolio $${(portfolio.totalValueUsd * 0.15).toFixed(0)}`;
    }

    // Rule 5: Confidence floor — never act on low-confidence proposals
    if (proposal.confidence < 0.55) {
      return `Proposal confidence ${proposal.confidence.toFixed(2)} below minimum 0.55`;
    }

    // Rule 6: Human approval for large trades
    const tradeUsd = this.estimateTradeValue(action, portfolio);
    if (tradeUsd > this.config.risk.humanApprovalThresholdUsd) {
      // In production: emit approval request event, block until approved
      this.logger.warn(
        { tradeUsd, threshold: this.config.risk.humanApprovalThresholdUsd },
        "⚠️ Trade requires human approval — blocking (implement approval flow)"
      );
      return `Trade $${tradeUsd.toFixed(0)} requires human approval (threshold: $${this.config.risk.humanApprovalThresholdUsd})`;
    }

    return null;
  }

  private estimateTradeValue(action: ActionParams, portfolio: Portfolio): number {
    // Rough estimation — executor gets exact values
    switch (action.type) {
      case "rebalance":
        return portfolio.totalValueUsd * action.params.fraction;
      case "emergency_exit":
        return portfolio.totalValueUsd;
      default:
        return portfolio.totalValueUsd * 0.1; // conservative default
    }
  }
}
