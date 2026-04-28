/**
 * PortfolioMonitor — Real-time position and balance tracking.
 *
 * Reads native SOL balance + token accounts from the executor wallet.
 * Fetches SOL/USD price from Jupiter price API (no auth needed).
 * Called by the conductor on every tick; result is published to Redis.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Portfolio, Position, SwarmConfig } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export class PortfolioMonitor {
  private connection: Connection;
  private walletAddress?: string;
  private cachedPortfolio?: Portfolio;
  private refreshInterval?: NodeJS.Timeout;
  private cachedSolPrice = 0;
  private lastPriceFetch = 0;

  constructor(
    private readonly config: SwarmConfig,
    private readonly logger: Logger
  ) {
    this.connection = new Connection(config.solana.rpcUrl, {
      wsEndpoint: config.solana.wsUrl,
      commitment: "confirmed",
    });
  }

  async start(walletAddress: string): Promise<void> {
    this.walletAddress = walletAddress;
    await this.refresh();

    this.refreshInterval = setInterval(() => {
      this.refresh().catch((e) =>
        this.logger.error({ err: e }, "Portfolio refresh error")
      );
    }, 20_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.refreshInterval);
  }

  async getPortfolio(): Promise<Portfolio> {
    if (!this.cachedPortfolio) await this.refresh();
    return this.cachedPortfolio!;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchSolPrice(): Promise<number> {
    // Cache price for 60s to avoid hammering the API
    if (this.cachedSolPrice > 0 && Date.now() - this.lastPriceFetch < 60_000) {
      return this.cachedSolPrice;
    }

    const tryJupiter = async (): Promise<number> => {
      const res = await fetch(
        `https://price.jup.ag/v6/price?ids=${SOL_MINT}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) throw new Error(`Jupiter price API ${res.status}`);
      const json = await res.json() as { data: Record<string, { price: number }> };
      return json.data[SOL_MINT]?.price ?? 0;
    };

    const tryCoingecko = async (): Promise<number> => {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) throw new Error(`CoinGecko price API ${res.status}`);
      const json = await res.json() as { solana: { usd: number } };
      return json.solana?.usd ?? 0;
    };

    for (const source of [tryJupiter, tryCoingecko]) {
      try {
        const price = await source();
        if (price > 0) {
          this.cachedSolPrice = price;
          this.lastPriceFetch = Date.now();
          return price;
        }
      } catch {
        // try next source
      }
    }

    this.logger.warn("SOL price fetch failed — using cached value");
    return this.cachedSolPrice || 150;
  }

  private async refresh(): Promise<void> {
    if (!this.walletAddress) return;

    try {
      const wallet = new PublicKey(this.walletAddress);
      const solPrice = await this.fetchSolPrice();

      // Native SOL balance
      const lamports = await this.connection.getBalance(wallet);
      const solBalance = lamports / LAMPORTS_PER_SOL;
      const solValueUsd = solBalance * solPrice;

      // Token accounts (USDC, etc.)
      let idleUsdc = 0;
      const positions: Position[] = [];

      try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          wallet,
          { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
        );

        for (const account of tokenAccounts.value) {
          const info = account.account.data.parsed?.info as {
            mint: string;
            tokenAmount: { uiAmount: number };
          } | undefined;

          if (!info || info.tokenAmount.uiAmount === 0) continue;

          if (info.mint === USDC_MINT) {
            idleUsdc += info.tokenAmount.uiAmount;
          }
        }
      } catch {
        // Token account fetch is non-critical — continue with SOL balance only
      }

      const totalValueUsd = solValueUsd + idleUsdc;

      // Idle SOL shows as a native position so the dashboard has something to render
      if (solBalance > 0.001) {
        positions.push({
          id: "native-sol",
          protocol: "native",
          poolAddress: this.walletAddress,
          tokenA: "SOL",
          tokenB: "",
          amountA: solBalance,
          amountB: 0,
          valueUsd: solValueUsd,
          entryValueUsd: this.cachedPortfolio?.positions.find((p) => p.id === "native-sol")?.entryValueUsd ?? solValueUsd,
          pnlUsd: 0,
          pnlPct: 0,
          openedAt: new Date(),
          apyAtEntry: 0,
          currentApy: 0,
        });
      }

      const portfolio: Portfolio = {
        walletAddress: this.walletAddress,
        totalValueUsd,
        positions,
        idleUsdc,
        lastUpdated: new Date(),
        allTimeReturnPct: this.cachedPortfolio?.allTimeReturnPct ?? 0,
        dailyReturnPct: this.cachedPortfolio
          ? this.cachedPortfolio.totalValueUsd > 0
            ? (totalValueUsd - this.cachedPortfolio.totalValueUsd) /
              this.cachedPortfolio.totalValueUsd
            : 0
          : 0,
      };

      this.cachedPortfolio = portfolio;

      this.logger.info(
        {
          solBalance: solBalance.toFixed(4),
          solPrice: solPrice.toFixed(2),
          totalValueUsd: totalValueUsd.toFixed(2),
          idleUsdc: idleUsdc.toFixed(2),
        },
        "Portfolio refreshed"
      );
    } catch (err) {
      this.logger.error({ err }, "Portfolio refresh failed");
    }
  }
}