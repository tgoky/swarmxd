/**
 * PortfolioMonitor — Real-time position tracking.
 *
 * Uses Helius enhanced RPC for:
 * - Token account balances
 * - LP position values (via program account parsing)
 * - Pending rewards
 * - PnL tracking
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type { Portfolio, Position, SwarmConfig } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

export class PortfolioMonitor {
  private connection: Connection;
  private walletAddress?: string;
  private cachedPortfolio?: Portfolio;
  private refreshInterval?: NodeJS.Timeout;

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

    // Refresh every 20s
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((e) => this.logger.error({ err: e }, "Portfolio refresh error"));
    }, 20_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.refreshInterval);
  }

  async getPortfolio(): Promise<Portfolio> {
    if (!this.cachedPortfolio) {
      await this.refresh();
    }
    return this.cachedPortfolio!;
  }

  private async refresh(): Promise<void> {
    if (!this.walletAddress) return;

    try {
      const wallet = new PublicKey(this.walletAddress);

      // Fetch all token accounts
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      // In production: parse LP positions from Raydium/Orca program accounts
      // For now, build portfolio from token balances
      const positions: Position[] = [];
      let totalValueUsd = 0;
      let idleUsdc = 0;

      for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed?.info;
        if (!info || info.tokenAmount.uiAmount === 0) continue;

        const mint = info.mint as string;
        const amount = info.tokenAmount.uiAmount as number;

        // USDC detection
        if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
          idleUsdc += amount;
          totalValueUsd += amount;
        }

        // In production: fetch price from Pyth/Jupiter and build position
      }

      const portfolio: Portfolio = {
        walletAddress: this.walletAddress,
        totalValueUsd,
        positions,
        idleUsdc,
        lastUpdated: new Date(),
        allTimeReturnPct: this.cachedPortfolio?.allTimeReturnPct ?? 0,
        dailyReturnPct: 0,
      };

      // Calculate daily return
      if (this.cachedPortfolio) {
        portfolio.dailyReturnPct =
          (totalValueUsd - this.cachedPortfolio.totalValueUsd) / this.cachedPortfolio.totalValueUsd;
      }

      this.cachedPortfolio = portfolio;
      this.logger.debug({ totalValueUsd, positionCount: positions.length }, "Portfolio refreshed");
    } catch (err) {
      this.logger.error({ err }, "Portfolio refresh failed");
    }
  }
}
