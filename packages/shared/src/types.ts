/**
 * @swarm/shared — Core types, interfaces, and utilities
 * Every agent and the conductor imports from here.
 */

// ─── Agent Identity ──────────────────────────────────────────────────────────

export type AgentRole =
  | "conductor"
  | "researcher"
  | "risk-assessor"
  | "executor"
  | "rebalancer";

export type AgentStatus =
  | "idle"
  | "analyzing"
  | "voting"
  | "executing"
  | "error"
  | "halted";

export interface AgentMetadata {
  id: string;
  role: AgentRole;
  version: string;
  startedAt: Date;
  lastHeartbeat: Date;
}

// ─── Market Data ─────────────────────────────────────────────────────────────

export interface TokenPrice {
  mint: string;
  symbol: string;
  priceUsd: number;
  change24h: number;
  volume24h: number;
  marketCap: number;
  timestamp: Date;
}

export interface PoolData {
  address: string;
  protocol: DeFiProtocol;
  tokenA: string;
  tokenB: string;
  tvlUsd: number;
  apyBase: number;         // Base trading fee APY
  apyReward: number;       // Incentive reward APY
  apyTotal: number;        // Combined APY
  apyPredicted24h?: number; // AI-predicted APY in 24h
  volume24h: number;
  feeRate: number;
  riskScore: number;       // 0-100, higher = riskier
  liquidityDepth: LiquidityDepth;
  impermanentLossEstimate: number; // % IL estimate at current volatility
  timestamp: Date;
}

export interface LiquidityDepth {
  bpsFrom2pct: number;   // USD liquidity within 2% of price
  bpsFrom5pct: number;
  bpsFrom10pct: number;
}

export type DeFiProtocol =
  | "jupiter"
  | "raydium"
  | "orca"
  | "meteora"
  | "lifinity"
  | "whirlpool"
  | "drift"
  | "mango"
  | "kamino"
  | "native";

// ─── Portfolio ───────────────────────────────────────────────────────────────

export interface Position {
  id: string;
  protocol: DeFiProtocol;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  amountA: number;
  amountB: number;
  valueUsd: number;
  entryValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  openedAt: Date;
  apyAtEntry: number;
  currentApy: number;
}

export interface Portfolio {
  walletAddress: string;
  totalValueUsd: number;
  positions: Position[];
  idleUsdc: number;
  lastUpdated: Date;
  allTimeReturnPct: number;
  dailyReturnPct: number;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

export type SignalType =
  | "apy_spike"          // Protocol APY suddenly jumped
  | "apy_collapse"       // APY about to crater
  | "price_divergence"   // Arbitrage opportunity
  | "liquidity_drain"    // TVL dropping fast (exit signal)
  | "sentiment_spike"    // Social/X sentiment surge
  | "whale_move"         // Large wallet activity detected
  | "new_pool"           // High-yield new pool launched
  | "risk_alert"         // Risk threshold exceeded
  | "rebalance_due"      // Portfolio drift too far from target
  | "emergency_exit";    // Critical — exit all positions NOW

export interface Signal {
  id: string;
  type: SignalType;
  priority: "low" | "medium" | "high" | "critical";
  source: "on-chain" | "oracle" | "social" | "ai" | "scheduled";
  data: Record<string, unknown>;
  confidence: number; // 0-1
  detectedAt: Date;
  expiresAt?: Date;
}

// ─── Agent Proposals ─────────────────────────────────────────────────────────

export type ActionType =
  | "swap"
  | "add_liquidity"
  | "remove_liquidity"
  | "rebalance"
  | "harvest_rewards"
  | "emergency_exit"
  | "hold";

export interface SwapParams {
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  minAmountOut: bigint;
  slippageBps: number;
  route?: string[]; // Intermediate hops
}

export interface LiquidityParams {
  poolAddress: string;
  protocol: DeFiProtocol;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  slippageBps: number;
  minLpTokens?: bigint;
}

export interface RebalanceParams {
  fromPool: string;
  toPool: string;
  fromProtocol: DeFiProtocol;
  toProtocol: DeFiProtocol;
  fraction: number;       // 0-1, what fraction of position to move
  reason: string;
  estimatedApyGain: number;
  estimatedCostBps: number;
}

export type ActionParams =
  | { type: "swap"; params: SwapParams }
  | { type: "add_liquidity"; params: LiquidityParams }
  | { type: "remove_liquidity"; params: Pick<LiquidityParams, "poolAddress" | "protocol"> & { lpTokenAmount: bigint; minTokenA: bigint; minTokenB: bigint } }
  | { type: "rebalance"; params: RebalanceParams }
  | { type: "harvest_rewards"; params: { positions: string[] } }
  | { type: "emergency_exit"; params: { positions: string[]; reason: string } }
  | { type: "hold"; params: { reason: string; revisitIn: number } };

export interface AgentProposal {
  id: string;
  agentId: string;
  agentRole: AgentRole;
  signalId: string;
  action: ActionParams;
  reasoning: string;         // Plain-English explanation for the log
  confidence: number;        // 0-1
  expectedReturnUsd: number;
  maxDownsideUsd: number;
  estimatedGasLamports: number;
  urgency: "low" | "medium" | "high" | "critical";
  createdAt: Date;
  expiresAt: Date;
}

// ─── Consensus ───────────────────────────────────────────────────────────────

export type VoteDecision = "approve" | "reject" | "abstain";

export interface AgentVote {
  agentId: string;
  agentRole: AgentRole;
  proposalId: string;
  decision: VoteDecision;
  confidence: number;
  reasoning: string;
  votedAt: Date;
}

export interface ConsensusResult {
  proposalId: string;
  passed: boolean;
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  totalVotes: number;
  weightedScore: number; // Risk-assessor votes count 1.5x
  finalAction: ActionParams | null;
  consensusAt: Date;
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type ExecutionStatus =
  | "pending"
  | "simulating"
  | "awaiting_approval"
  | "submitted"
  | "confirmed"
  | "failed"
  | "reverted";

export interface ExecutionRecord {
  id: string;
  consensusResultId: string;
  action: ActionParams;
  status: ExecutionStatus;
  txSignatures: string[];
  gasUsedLamports: number;
  actualSlippageBps: number;
  errorMessage?: string;
  simulationResult?: SimulationResult;
  submittedAt?: Date;
  confirmedAt?: Date;
  blockHeight?: number;
}

export interface SimulationResult {
  success: boolean;
  estimatedGasLamports: number;
  balanceChanges: Record<string, bigint>;
  warnings: string[];
  errors: string[];
}

// ─── On-Chain Memory ─────────────────────────────────────────────────────────

export interface HiveMindEntry {
  sequenceNumber: number;
  signalId: string;
  proposalId: string;
  consensusHash: string;   // Keccak of consensus result
  actionSummary: string;   // Short human-readable
  txSignatures: string[];
  netPnlUsd: number;
  timestamp: number;       // Unix timestamp
  agents: string[];        // Pubkeys of agents that voted
}

// ─── Swarm State ─────────────────────────────────────────────────────────────

export interface SwarmState {
  conductorId: string;
  epoch: number;
  agents: Map<string, AgentMetadata>;
  portfolio: Portfolio;
  activeSignals: Signal[];
  pendingProposals: AgentProposal[];
  activeVotes: Map<string, AgentVote[]>;
  recentExecutions: ExecutionRecord[];
  isHalted: boolean;
  haltReason?: string;
  stats: SwarmStats;
}

export interface SwarmStats {
  totalTradesExecuted: number;
  totalVolumeUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  winRate: number;
  avgApyAchieved: number;
  uptimeSeconds: number;
  lastSignalAt?: Date;
  lastExecutionAt?: Date;
}

// ─── Messaging Bus (Redis Pub/Sub channels) ──────────────────────────────────

export const CHANNELS = {
  SIGNAL_NEW: "swarm:signal:new",
  SIGNAL_EXPIRED: "swarm:signal:expired",
  PROPOSAL_NEW: "swarm:proposal:new",
  VOTE_CAST: "swarm:vote:cast",
  CONSENSUS_REACHED: "swarm:consensus:reached",
  EXECUTION_UPDATE: "swarm:execution:update",
  PORTFOLIO_UPDATE: "swarm:portfolio:update",
  POOL_DATA_UPDATE: "swarm:pool:update",
  AGENT_HEARTBEAT: "swarm:agent:heartbeat",
  SWARM_HALT: "swarm:halt",
  SWARM_RESUME: "swarm:resume",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

export interface BusMessage<T = unknown> {
  channel: ChannelName;
  senderId: string;
  payload: T;
  timestamp: Date;
  correlationId?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SwarmConfig {
  solana: {
    rpcUrl: string;
    wsUrl: string;
    network: "mainnet-beta" | "devnet" | "localnet" | "testnet";
  };
  risk: {
    maxPortfolioValueUsd: number;
    maxTradeSizePct: number;
    stopLossPct: number;
    maxSlippageBps: number;
    humanApprovalThresholdUsd: number;
  };
  conductor: {
    tickMs: number;
    consensusThreshold: number;
    agentTimeoutMs: number;
  };
  protocols: {
    enabled: DeFiProtocol[];
    maxExposurePct: Record<DeFiProtocol, number>;
  };
}