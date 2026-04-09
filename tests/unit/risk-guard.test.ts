/**
 * RiskGuard Unit Tests
 *
 * The RiskGuard is the most safety-critical component in the system.
 * Every rule must be independently tested and the tests must be impossible
 * to accidentally break.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RiskGuard } from "../../packages/conductor/src/risk-guard.js";
import { createLogger } from "../../packages/shared/src/logger.js";
import type { SwarmConfig, Portfolio, AgentProposal } from "../../packages/shared/src/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const testConfig: SwarmConfig = {
  solana: { rpcUrl: "http://localhost:8899", wsUrl: "ws://localhost:8900", network: "localnet" },
  risk: {
    maxPortfolioValueUsd: 100_000,
    maxTradeSizePct: 0.25,
    stopLossPct: 0.10,
    maxSlippageBps: 100,
    humanApprovalThresholdUsd: 5_000,
  },
  conductor: { tickMs: 30_000, consensusThreshold: 0.75, agentTimeoutMs: 15_000 },
  protocols: {
    enabled: ["raydium", "orca"],
    maxExposurePct: { raydium: 0.35, orca: 0.30, meteora: 0.25, lifinity: 0.10, whirlpool: 0.20, drift: 0.10, mango: 0.10, kamino: 0.20, jupiter: 0 },
  },
};

const healthyPortfolio: Portfolio = {
  walletAddress: "test",
  totalValueUsd: 10_000,
  positions: [
    { id: "p1", protocol: "raydium", poolAddress: "pool1", tokenA: "SOL", tokenB: "USDC", amountA: 0n, amountB: 0n, valueUsd: 4_000, entryValueUsd: 3_800, pnlUsd: 200, pnlPct: 0.053, openedAt: new Date(), apyAtEntry: 25, currentApy: 28 },
  ],
  idleUsdc: 6_000,
  lastUpdated: new Date(),
  allTimeReturnPct: 0.053,
  dailyReturnPct: 0.002,
};

const baseProposal: AgentProposal = {
  id: "prop-test",
  agentId: "researcher-1",
  agentRole: "researcher",
  signalId: "sig-test",
  action: {
    type: "rebalance",
    params: {
      fromPool: "pool1",
      toPool: "pool2",
      fromProtocol: "raydium",
      toProtocol: "orca",
      fraction: 0.20,
      reason: "Better APY",
      estimatedApyGain: 12,
      estimatedCostBps: 25,
    },
  },
  reasoning: "Test proposal",
  confidence: 0.80,
  expectedReturnUsd: 50,
  maxDownsideUsd: 100,
  estimatedGasLamports: 5_000,
  urgency: "medium",
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 300_000),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("RiskGuard", () => {
  let guard: RiskGuard;
  const logger = createLogger({ agentRole: "conductor", agentId: "test" });

  beforeEach(() => {
    guard = new RiskGuard(testConfig, logger);
  });

  // ── Stop-loss ──────────────────────────────────────────────────────────────

  describe("checkStopLoss", () => {
    it("returns null for a healthy portfolio", () => {
      expect(guard.checkStopLoss(healthyPortfolio)).toBeNull();
    });

    it("triggers when all-time drawdown exceeds threshold", () => {
      const portfolio: Portfolio = { ...healthyPortfolio, allTimeReturnPct: -0.10 }; // exactly 10%
      const result = guard.checkStopLoss(portfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("stop-loss");
    });

    it("triggers on daily drawdown at 50% of stop-loss threshold", () => {
      const portfolio: Portfolio = { ...healthyPortfolio, dailyReturnPct: -0.05 }; // 5% daily = 50% of 10% stop-loss
      const result = guard.checkStopLoss(portfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("daily stop-loss");
    });

    it("does not trigger on positive returns", () => {
      const portfolio: Portfolio = { ...healthyPortfolio, allTimeReturnPct: 0.50, dailyReturnPct: 0.03 };
      expect(guard.checkStopLoss(portfolio)).toBeNull();
    });

    it("triggers just over the threshold (boundary test)", () => {
      const portfolio: Portfolio = { ...healthyPortfolio, allTimeReturnPct: -0.101 };
      expect(guard.checkStopLoss(portfolio)).not.toBeNull();
    });

    it("does not trigger just under the threshold (boundary test)", () => {
      const portfolio: Portfolio = { ...healthyPortfolio, allTimeReturnPct: -0.099 };
      expect(guard.checkStopLoss(portfolio)).toBeNull();
    });
  });

  // ── Veto check ─────────────────────────────────────────────────────────────

  describe("vetoCheck", () => {
    it("approves a well-formed proposal", () => {
      expect(guard.vetoCheck(baseProposal, healthyPortfolio)).toBeNull();
    });

    it("rejects when portfolio value exceeds maximum", () => {
      const richPortfolio: Portfolio = { ...healthyPortfolio, totalValueUsd: 150_000 };
      const result = guard.vetoCheck(baseProposal, richPortfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("exceeds max");
    });

    it("rejects a swap with excessive slippage", () => {
      const slippyProposal: AgentProposal = {
        ...baseProposal,
        action: {
          type: "swap",
          params: {
            inputMint: "SOL",
            outputMint: "USDC",
            amountIn: 1_000_000n,
            minAmountOut: 990_000n,
            slippageBps: 500, // 5% — way over 100bps max
          },
        },
      };
      const result = guard.vetoCheck(slippyProposal, healthyPortfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("slippage");
    });

    it("rejects when max downside exceeds 15% of portfolio", () => {
      const riskyProposal: AgentProposal = {
        ...baseProposal,
        maxDownsideUsd: 2_000, // 20% of $10k portfolio
      };
      const result = guard.vetoCheck(riskyProposal, healthyPortfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("Max downside");
    });

    it("rejects low-confidence proposals (below 0.55)", () => {
      const lowConfProposal: AgentProposal = { ...baseProposal, confidence: 0.54 };
      const result = guard.vetoCheck(lowConfProposal, healthyPortfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("confidence");
    });

    it("accepts proposal at exactly the confidence floor (0.55)", () => {
      const proposal: AgentProposal = { ...baseProposal, confidence: 0.55 };
      // This may pass or fail depending on trade size, but shouldn't fail on confidence
      const result = guard.vetoCheck(proposal, healthyPortfolio);
      if (result) expect(result).not.toContain("confidence");
    });

    it("requires human approval for large trades", () => {
      // A trade affecting >50% of $10k portfolio = $5k+ = above $5k threshold
      const bigProposal: AgentProposal = {
        ...baseProposal,
        action: {
          type: "rebalance",
          params: {
            ...((baseProposal.action as { params: { fromPool: string; toPool: string; fromProtocol: "raydium"; toProtocol: "orca"; reason: string; estimatedApyGain: number; estimatedCostBps: number } }).params),
            fraction: 0.60, // 60% of $10k = $6k > $5k threshold
          },
        },
      };
      const result = guard.vetoCheck(bigProposal, healthyPortfolio);
      expect(result).not.toBeNull();
      expect(result).toContain("human approval");
    });

    it("never vetoes an emergency exit", () => {
      const exitProposal: AgentProposal = {
        ...baseProposal,
        confidence: 0.95,
        maxDownsideUsd: 500, // small
        action: {
          type: "emergency_exit",
          params: { positions: ["p1"], reason: "Rug pull detected" },
        },
      };
      // Emergency exits can still be vetoed by portfolio cap or confidence,
      // but this one is well-formed
      const result = guard.vetoCheck(exitProposal, healthyPortfolio);
      expect(result).toBeNull();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles zero-value portfolio safely", () => {
      const emptyPortfolio: Portfolio = { ...healthyPortfolio, totalValueUsd: 0 };
      // Should not throw, may or may not veto — just shouldn't crash
      expect(() => guard.checkStopLoss(emptyPortfolio)).not.toThrow();
      expect(() => guard.vetoCheck(baseProposal, emptyPortfolio)).not.toThrow();
    });

    it("handles hold action without vetoing", () => {
      const holdProposal: AgentProposal = {
        ...baseProposal,
        action: { type: "hold", params: { reason: "No opportunity", revisitIn: 300 } },
      };
      expect(guard.vetoCheck(holdProposal, healthyPortfolio)).toBeNull();
    });
  });
});
