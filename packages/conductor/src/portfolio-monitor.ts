/**
 * PortfolioMonitor — Real-time position and balance tracking.
 *
 * When HELIUS_API_KEY is set:
 *   - Uses Helius RPC (better reliability, no rate limits for DAS)
 *   - Calls getAssetsByOwner (DAS) to detect LP position NFTs
 *     (Raydium CLMM, Orca Whirlpool, Meteora DLMM)
 *
 * Without the key: falls back to public Solana RPC + token accounts only.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Portfolio, Position, SwarmConfig } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Known LP program IDs on Solana mainnet
const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

interface DasAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  };
  authorities?: Array<{ address: string; scopes: string[] }>;
  grouping?: Array<{ group_key: string; group_value: string }>;
  token_info?: {
    balance?: number;
    decimals?: number;
    token_program?: string;
    associated_token_address?: string;
  };
}

export class PortfolioMonitor {
  private connection: Connection;
  private heliusRpcUrl?: string;
  private walletAddress?: string;
  private cachedPortfolio?: Portfolio;
  private refreshInterval?: NodeJS.Timeout;
  private cachedSolPrice = 0;
  private lastPriceFetch = 0;

  constructor(
    private readonly config: SwarmConfig,
    private readonly logger: Logger
  ) {
    const heliusKey = process.env["HELIUS_API_KEY"];
    if (heliusKey) {
      this.heliusRpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      this.logger.info("PortfolioMonitor using Helius RPC + DAS");
    }

    const rpcUrl = this.heliusRpcUrl ?? config.solana.rpcUrl;
    this.connection = new Connection(rpcUrl, {
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

      let idleUsdc = 0;
      const positions: Position[] = [];

      // Token accounts (USDC, etc.)
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
        // Non-critical — continue with SOL balance only
      }

      // LP position NFTs via Helius DAS
      if (this.heliusRpcUrl) {
        const lpPositions = await this.fetchLpPositions(this.walletAddress, solPrice);
        positions.push(...lpPositions);
      }

      const totalValueUsd =
        solValueUsd + idleUsdc + positions.reduce((s, p) => s + p.valueUsd, 0);

      // Idle SOL shows as a native position
      if (solBalance > 0.001) {
        positions.unshift({
          id: "native-sol",
          protocol: "native",
          poolAddress: this.walletAddress,
          tokenA: "SOL",
          tokenB: "",
          amountA: solBalance,
          amountB: 0,
          valueUsd: solValueUsd,
          entryValueUsd:
            this.cachedPortfolio?.positions.find((p) => p.id === "native-sol")?.entryValueUsd ??
            solValueUsd,
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
          lpPositions: positions.filter((p) => p.protocol !== "native").length,
        },
        "Portfolio refreshed"
      );
    } catch (err) {
      this.logger.error({ err }, "Portfolio refresh failed");
    }
  }

  // ── LP position detection via Helius DAS ──────────────────────────────────

  private async fetchLpPositions(
    walletAddress: string,
    solPrice: number
  ): Promise<Position[]> {
    if (!this.heliusRpcUrl) return [];

    try {
      const res = await fetch(this.heliusRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "portfolio-monitor",
          method: "getAssetsByOwner",
          params: {
            ownerAddress: walletAddress,
            page: 1,
            limit: 1000,
            displayOptions: { showFungible: false, showNativeBalance: false },
          },
        }),
      });

      if (!res.ok) {
        this.logger.debug({ status: res.status }, "DAS getAssetsByOwner failed");
        return [];
      }

      const json = await res.json() as {
        result?: { items?: DasAsset[]; total?: number };
        error?: { message: string };
      };

      if (json.error) {
        this.logger.debug({ err: json.error.message }, "DAS error");
        return [];
      }

      const assets = json.result?.items ?? [];
      const lpPositions: Position[] = [];

      for (const asset of assets) {
        const position = await this.tryDecodeLpAsset(asset, solPrice);
        if (position) lpPositions.push(position);
      }

      if (lpPositions.length > 0) {
        this.logger.info({ count: lpPositions.length }, "LP positions detected via DAS");
      }

      return lpPositions;
    } catch (err) {
      this.logger.debug({ err }, "LP position fetch failed (non-fatal)");
      return [];
    }
  }

  private async tryDecodeLpAsset(
    asset: DasAsset,
    _solPrice: number
  ): Promise<Position | null> {
    // Only process NFTs (LP positions are NFTs)
    if (asset.interface !== "V1_NFT" && asset.interface !== "ProgrammableNFT") return null;

    const name = asset.content?.metadata?.name ?? "";
    const authorities = asset.authorities?.map((a) => a.address) ?? [];

    // Identify Raydium CLMM positions
    const isRaydiumClmm =
      authorities.includes(RAYDIUM_CLMM_PROGRAM) ||
      name.toLowerCase().includes("raydium concentrated") ||
      name.toLowerCase().includes("raydium clmm");

    // Identify Orca Whirlpool positions
    const isOrcaWhirlpool =
      authorities.includes(ORCA_WHIRLPOOL_PROGRAM) ||
      name.toLowerCase().includes("orca position") ||
      name.toLowerCase().includes("whirlpool");

    // Identify Meteora DLMM positions
    const isMeteora =
      authorities.includes(METEORA_DLMM_PROGRAM) ||
      name.toLowerCase().includes("meteora");

    if (!isRaydiumClmm && !isOrcaWhirlpool && !isMeteora) return null;

    const protocol = isRaydiumClmm ? "raydium" : isOrcaWhirlpool ? "orca" : "meteora";

    // Attempt to get exact position value from Orca's REST API
    let valueUsd = 0;
    if (isOrcaWhirlpool) {
      valueUsd = await this.fetchOrcaPositionValue(asset.id);
    }

    const existingPos = this.cachedPortfolio?.positions.find((p) => p.id === asset.id);

    return {
      id: asset.id,
      protocol,
      poolAddress: asset.id, // NFT mint = position identifier
      tokenA: "unknown",
      tokenB: "unknown",
      amountA: 0,
      amountB: 0,
      valueUsd,
      entryValueUsd: existingPos?.entryValueUsd ?? valueUsd,
      pnlUsd: existingPos ? valueUsd - existingPos.entryValueUsd : 0,
      pnlPct: existingPos?.entryValueUsd
        ? (valueUsd - existingPos.entryValueUsd) / existingPos.entryValueUsd
        : 0,
      openedAt: existingPos?.openedAt ?? new Date(),
      apyAtEntry: existingPos?.apyAtEntry ?? 0,
      currentApy: 0, // Would need SDK to compute in-range fee APY
    };
  }

  private async fetchOrcaPositionValue(positionMint: string): Promise<number> {
    try {
      const res = await fetch(
        `https://api.mainnet.orca.so/v1/position/${positionMint}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return 0;

      const json = await res.json() as {
        positionUSD?: number;
        totalValueUSD?: number;
      };

      return json.positionUSD ?? json.totalValueUSD ?? 0;
    } catch {
      return 0;
    }
  }
}
