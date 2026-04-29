/**
 * PoolFetcher — Single source of truth for DeFi pool market data.
 *
 * Priority order:
 * 1. Birdeye (requires BIRDEYE_API_KEY) — aggregates all Solana DEXs with APY + TVL
 * 2. Raydium CLMM — public API, no key needed
 * 3. Orca Whirlpools — public API, no key needed
 * 4. Meteora — public API fallback
 *
 * Tracks previousApy per pool for APY spike/collapse signal detection.
 * Exposes getBestPool() for rebalancer to resolve placeholder pool names.
 */

import type { PoolData, DeFiProtocol } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

interface PoolEntry extends PoolData {
  previousApy?: number;
}

const MIN_TVL_USD = 100_000;
const FETCH_INTERVAL_MS = 30_000;

export class PoolFetcher {
  private readonly pools = new Map<string, PoolEntry>();
  private fetchInterval?: NodeJS.Timeout;

  constructor(private readonly logger: Logger) {}

  async start(): Promise<void> {
    await this.fetchAll();
    this.fetchInterval = setInterval(() => {
      this.fetchAll().catch((e) => this.logger.error({ err: e }, "Pool fetch cycle error"));
    }, FETCH_INTERVAL_MS);
    this.logger.info({ pools: this.pools.size }, "Pool fetcher started");
  }

  async stop(): Promise<void> {
    clearInterval(this.fetchInterval);
  }

  getPools(): PoolData[] {
    return Array.from(this.pools.values());
  }

  getPoolsWithHistory(): Array<PoolData & { previousApy?: number }> {
    return Array.from(this.pools.values());
  }

  getPool(address: string): PoolData | undefined {
    return this.pools.get(address);
  }

  /**
   * Find the best pool matching the given criteria.
   * Used by rebalancer to resolve "best-available" / "best-in-range" placeholders.
   */
  getBestPool(opts: {
    preferProtocol?: DeFiProtocol;
    minTvl?: number;
    maxRisk?: number;
    excludePool?: string;
    minApy?: number;
  } = {}): PoolData | null {
    const { preferProtocol, minTvl = MIN_TVL_USD, maxRisk = 70, excludePool, minApy = 1 } = opts;

    let candidates = Array.from(this.pools.values()).filter(
      (p) =>
        p.tvlUsd >= minTvl &&
        p.riskScore <= maxRisk &&
        p.apyTotal >= minApy &&
        p.address !== excludePool
    );

    if (preferProtocol) {
      const protocolPools = candidates.filter((p) => p.protocol === preferProtocol);
      if (protocolPools.length > 0) candidates = protocolPools;
    }

    if (candidates.length === 0) return null;

    // Score: weighted combination of APY and TVL depth (size-adjusted)
    candidates.sort((a, b) => {
      const aScore = a.apyTotal * 0.7 + Math.min(a.tvlUsd / 1_000_000, 10) * 3;
      const bScore = b.apyTotal * 0.7 + Math.min(b.tvlUsd / 1_000_000, 10) * 3;
      return bScore - aScore;
    });

    return candidates[0] ?? null;
  }

  // ── Fetch orchestration ───────────────────────────────────────────────────

  private async fetchAll(): Promise<void> {
    const results = await Promise.allSettled([
      this.fetchBirdeye(),
      this.fetchRaydiumClmm(),
      this.fetchOrcaWhirlpools(),
      this.fetchMeteora(),
    ]);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const sources = ["Birdeye", "Raydium CLMM", "Orca Whirlpools", "Meteora"];
        this.logger.debug({ err: r.reason, source: sources[i] }, "Pool source failed (non-fatal)");
      }
    });

    this.logger.debug({ total: this.pools.size }, "Pool data refreshed");
  }

  private setPool(entry: Omit<PoolEntry, "previousApy" | "timestamp"> & { timestamp?: Date }): void {
    const existing = this.pools.get(entry.address);
    this.pools.set(entry.address, {
      ...entry,
      timestamp: entry.timestamp ?? new Date(),
      ...(existing ? { previousApy: existing.apyTotal } : {}),
    });
  }

  private estimateRiskScore(tvlUsd: number, volume24h: number): number {
    let score = 100;
    if (tvlUsd > 10_000_000) score -= 30;
    else if (tvlUsd > 1_000_000) score -= 15;
    if (volume24h > 1_000_000) score -= 20;
    else if (volume24h > 100_000) score -= 10;
    return Math.max(10, Math.min(100, score));
  }

  // ── Birdeye (primary — requires API key) ─────────────────────────────────

  private async fetchBirdeye(): Promise<void> {
    const apiKey = process.env["BIRDEYE_API_KEY"];
    if (!apiKey) return;

    const res = await fetch(
      "https://public-api.birdeye.so/defi/pools?sort_by=apy&sort_type=desc&limit=50&offset=0",
      {
        headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) throw new Error(`Birdeye pools ${res.status}`);

    const json = await res.json() as {
      data?: {
        items?: Array<{
          address?: string;
          name?: string;
          source?: string;
          base_symbol?: string;
          quote_symbol?: string;
          liquidity?: number;
          volume24h?: number;
          apy24h?: number;
        }>;
      };
    };

    const items = json.data?.items ?? [];

    for (const item of items) {
      if (!item.address) continue;
      const tvl = item.liquidity ?? 0;
      if (tvl < MIN_TVL_USD) continue;

      const volume = item.volume24h ?? 0;
      const apy = item.apy24h ?? 0;
      const protocol = this.sourceToProtocol(item.source ?? "");

      this.setPool({
        address: item.address,
        protocol,
        tokenA: item.base_symbol ?? "unknown",
        tokenB: item.quote_symbol ?? "unknown",
        tvlUsd: tvl,
        apyBase: apy * 0.65,
        apyReward: apy * 0.35,
        apyTotal: apy,
        volume24h: volume,
        feeRate: 0.003,
        riskScore: this.estimateRiskScore(tvl, volume),
        liquidityDepth: { bpsFrom2pct: 0, bpsFrom5pct: 0, bpsFrom10pct: 0 },
        impermanentLossEstimate: 0,
      });
    }

    this.logger.debug({ count: items.length }, "Birdeye pools fetched");
  }

  // ── Raydium CLMM (fallback) ────────────────────────────────────────────────

  private async fetchRaydiumClmm(): Promise<void> {
    const url = process.env["RAYDIUM_CLMM_API_URL"] ?? "https://api.raydium.io/v2/ammV3/ammPools";
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Raydium CLMM ${res.status}`);

    const json = await res.json() as {
      data?: Array<{
        id?: string;
        mintA?: { address?: string; symbol?: string };
        mintB?: { address?: string; symbol?: string };
        tvl?: number;
        day?: { apr?: number; feeApr?: number; volumeQuote?: number };
      }>;
    };

    let count = 0;
    for (const pool of json.data ?? []) {
      if (!pool.id) continue;
      const tvl = pool.tvl ?? 0;
      if (tvl < MIN_TVL_USD) continue;
      if (this.pools.has(pool.id)) continue; // Birdeye already covers it

      const volume = pool.day?.volumeQuote ?? 0;
      const feeApr = pool.day?.feeApr ?? 0;
      const totalApr = pool.day?.apr ?? feeApr;

      this.setPool({
        address: pool.id,
        protocol: "raydium",
        tokenA: pool.mintA?.symbol ?? "unknown",
        tokenB: pool.mintB?.symbol ?? "unknown",
        tvlUsd: tvl,
        apyBase: feeApr,
        apyReward: Math.max(0, totalApr - feeApr),
        apyTotal: totalApr,
        volume24h: volume,
        feeRate: 0.0025,
        riskScore: this.estimateRiskScore(tvl, volume),
        liquidityDepth: { bpsFrom2pct: 0, bpsFrom5pct: 0, bpsFrom10pct: 0 },
        impermanentLossEstimate: 0,
      });
      count++;
    }

    this.logger.debug({ count }, "Raydium CLMM pools fetched");
  }

  // ── Orca Whirlpools (fallback) ────────────────────────────────────────────

  private async fetchOrcaWhirlpools(): Promise<void> {
    const res = await fetch("https://api.mainnet.orca.so/v1/whirlpool/list", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Orca Whirlpools ${res.status}`);

    const json = await res.json() as {
      whirlpools?: Array<{
        address?: string;
        tokenA?: { mint?: string; symbol?: string };
        tokenB?: { mint?: string; symbol?: string };
        tvl?: number;
        volume?: { day?: number };
        feeApr?: number;
        rewardApr?: number[];
        totalApr?: number;
      }>;
    };

    let count = 0;
    for (const pool of json.whirlpools ?? []) {
      if (!pool.address) continue;
      const tvl = pool.tvl ?? 0;
      if (tvl < MIN_TVL_USD) continue;
      if (this.pools.has(pool.address)) continue;

      const volume = pool.volume?.day ?? 0;
      // Orca returns APR as decimals (0.05 = 5%)
      const feeApr = (pool.feeApr ?? 0) * 100;
      const rewardApr = (pool.rewardApr?.reduce((s, r) => s + r, 0) ?? 0) * 100;
      const totalApr = (pool.totalApr ?? 0) * 100 || feeApr + rewardApr;

      this.setPool({
        address: pool.address,
        protocol: "orca",
        tokenA: pool.tokenA?.symbol ?? "unknown",
        tokenB: pool.tokenB?.symbol ?? "unknown",
        tvlUsd: tvl,
        apyBase: feeApr,
        apyReward: rewardApr,
        apyTotal: totalApr,
        volume24h: volume,
        feeRate: 0.003,
        riskScore: this.estimateRiskScore(tvl, volume),
        liquidityDepth: { bpsFrom2pct: 0, bpsFrom5pct: 0, bpsFrom10pct: 0 },
        impermanentLossEstimate: 0,
      });
      count++;
    }

    this.logger.debug({ count }, "Orca Whirlpool pools fetched");
  }

  // ── Meteora (bonus fallback) ──────────────────────────────────────────────

  private async fetchMeteora(): Promise<void> {
    try {
      const res = await fetch("https://app.meteora.ag/amm/pools", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;

      const json = await res.json() as Array<{
        pool_address?: string;
        pool_token_mints?: string[];
        pool_tvl?: number;
        trading_volume?: number;
        apy?: number;
      }> | null;

      if (!Array.isArray(json)) return;
      let count = 0;

      for (const pool of json) {
        if (!pool.pool_address) continue;
        const tvl = pool.pool_tvl ?? 0;
        if (tvl < MIN_TVL_USD) continue;
        if (this.pools.has(pool.pool_address)) continue;

        const volume = pool.trading_volume ?? 0;
        const apy = pool.apy ?? 0;

        this.setPool({
          address: pool.pool_address,
          protocol: "meteora",
          tokenA: pool.pool_token_mints?.[0]?.slice(0, 4) ?? "unknown",
          tokenB: pool.pool_token_mints?.[1]?.slice(0, 4) ?? "unknown",
          tvlUsd: tvl,
          apyBase: apy * 0.6,
          apyReward: apy * 0.4,
          apyTotal: apy,
          volume24h: volume,
          feeRate: 0.002,
          riskScore: this.estimateRiskScore(tvl, volume),
          liquidityDepth: { bpsFrom2pct: 0, bpsFrom5pct: 0, bpsFrom10pct: 0 },
          impermanentLossEstimate: 0,
        });
        count++;
      }

      this.logger.debug({ count }, "Meteora pools fetched");
    } catch {
      // Meteora API is optional — swallow silently
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private sourceToProtocol(source: string): DeFiProtocol {
    const s = source.toLowerCase();
    if (s.includes("raydium")) return "raydium";
    if (s.includes("orca") || s.includes("whirlpool")) return "orca";
    if (s.includes("meteora")) return "meteora";
    if (s.includes("lifinity")) return "lifinity";
    if (s.includes("kamino")) return "kamino";
    if (s.includes("drift")) return "drift";
    if (s.includes("mango")) return "mango";
    return "raydium";
  }
}
