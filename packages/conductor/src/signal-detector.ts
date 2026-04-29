/**
 * SignalDetector — Watches for trading opportunities and risk events.
 *
 * Pool data is supplied by PoolFetcher (which handles Birdeye + Raydium CLMM
 * + Orca Whirlpool fetching on its own 30s cycle).
 * SignalDetector focuses purely on anomaly detection over that data.
 */

import type { Signal, Portfolio, SwarmConfig, PoolData } from "@swarm/shared";
import { nanoid } from "nanoid";
import type { Logger } from "@swarm/shared";
import type { PoolFetcher } from "./pool-fetcher.js";

export class SignalDetector {
  private previousPortfolioValue?: number;
  private lastRebalanceSignalAt = new Map<string, number>();
  private readonly rebalanceSignalCooldownMs = 5 * 60_000; // 5 min per position

  constructor(
    private readonly config: SwarmConfig,
    private readonly logger: Logger,
    private readonly poolFetcher: PoolFetcher
  ) {}

  async start(): Promise<void> {
    this.logger.info("Signal detector starting (pool data from PoolFetcher)");
  }

  async stop(): Promise<void> {
    // Nothing to clean up — PoolFetcher owns the fetch interval
  }

  /**
   * Called by conductor on each tick to collect new signals.
   */
  async detectSignals(portfolio: Portfolio): Promise<Signal[]> {
    const signals: Signal[] = [];
    const pools = this.poolFetcher.getPoolsWithHistory();

    // 1. APY spike / collapse detection
    for (const pool of pools) {
      if (pool.previousApy !== undefined) {
        const apyChange = pool.apyTotal - pool.previousApy;
        const apyChangePct = pool.previousApy > 0 ? apyChange / pool.previousApy : 0;

        if (apyChangePct > 0.20 && pool.apyTotal > 5) {
          signals.push(this.buildSignal("apy_spike", "high", "on-chain", {
            poolAddress: pool.address,
            protocol: pool.protocol,
            previousApy: pool.previousApy,
            currentApy: pool.apyTotal,
            changePct: apyChangePct,
            tvlUsd: pool.tvlUsd,
          }, 0.82));
        }

        if (apyChangePct < -0.40 && this.isInPosition(portfolio, pool.address)) {
          signals.push(this.buildSignal("apy_collapse", "high", "on-chain", {
            poolAddress: pool.address,
            protocol: pool.protocol,
            previousApy: pool.previousApy,
            currentApy: pool.apyTotal,
            changePct: apyChangePct,
          }, 0.90));
        }
      }
    }

    // 2. Arbitrage opportunity detection
    const arbSignal = await this.detectArbitrage();
    if (arbSignal) signals.push(arbSignal);

    // 3. Liquidity drain (TVL < $100k in a pool we're in)
    for (const pool of pools) {
      if (pool.tvlUsd < 100_000 && this.isInPosition(portfolio, pool.address)) {
        signals.push(this.buildSignal("liquidity_drain", "critical", "on-chain", {
          poolAddress: pool.address,
          protocol: pool.protocol,
          tvlUsd: pool.tvlUsd,
        }, 0.95));
      }
    }

    // 4. Portfolio rebalance check
    const rebalanceSignal = this.checkRebalanceDrift(portfolio);
    if (rebalanceSignal) signals.push(rebalanceSignal);

    // 5. Portfolio stop-loss
    if (this.previousPortfolioValue) {
      const pctDrop =
        (this.previousPortfolioValue - portfolio.totalValueUsd) / this.previousPortfolioValue;
      if (pctDrop > this.config.risk.stopLossPct * 0.8) {
        signals.push(this.buildSignal("risk_alert", "critical", "ai", {
          reason: `Portfolio down ${(pctDrop * 100).toFixed(1)}% — approaching stop-loss`,
          pctDrop,
          currentValue: portfolio.totalValueUsd,
        }, 0.99));
      }
    }
    this.previousPortfolioValue = portfolio.totalValueUsd;

    // 6. New high-APY pools
    for (const pool of pools) {
      if (pool.apyTotal > 80 && pool.tvlUsd > 500_000 && pool.riskScore < 60) {
        signals.push(this.buildSignal("new_pool", "medium", "on-chain", {
          poolAddress: pool.address,
          protocol: pool.protocol,
          apyTotal: pool.apyTotal,
          tvlUsd: pool.tvlUsd,
          riskScore: pool.riskScore,
        }, 0.70));
      }
    }

    return signals;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async detectArbitrage(): Promise<Signal | null> {
    try {
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

      const quoteUrl =
        `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=50`;

      const res = await fetch(quoteUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;

      // Arb signal generation would go here; returning null for now
      return null;
    } catch {
      return null;
    }
  }

  private checkRebalanceDrift(portfolio: Portfolio): Signal | null {
    for (const position of portfolio.positions) {
      const weight = position.valueUsd / portfolio.totalValueUsd;
      if (weight > 0.40) {
        const lastSent = this.lastRebalanceSignalAt.get(position.id) ?? 0;
        if (Date.now() - lastSent < this.rebalanceSignalCooldownMs) return null;
        this.lastRebalanceSignalAt.set(position.id, Date.now());
        return this.buildSignal("rebalance_due", "medium", "scheduled", {
          positionId: position.id,
          weight,
          poolAddress: position.poolAddress,
          reason: `Position is ${(weight * 100).toFixed(0)}% of portfolio — above 40% threshold`,
        }, 0.88);
      }
    }
    return null;
  }

  private isInPosition(portfolio: Portfolio, poolAddress: string): boolean {
    return portfolio.positions.some((p) => p.poolAddress === poolAddress);
  }

  private buildSignal(
    type: Signal["type"],
    priority: Signal["priority"],
    source: Signal["source"],
    data: Record<string, unknown>,
    confidence: number
  ): Signal {
    return {
      id: nanoid(16),
      type,
      priority,
      source,
      data,
      confidence,
      detectedAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60_000),
    };
  }

  getPoolData(): PoolData[] {
    return this.poolFetcher.getPools();
  }
}
