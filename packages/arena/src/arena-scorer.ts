/**
 * ArenaScorer — computes reputation scores for each registered swarm,
 * publishes leaderboard ticks and rank-update events via the MessageBus.
 *
 * Scoring formula:
 *   score = (winRate * 50) + (riskAdjustedReturn * 30) + (auditTrustScore * 20)
 *
 * Published channels:
 *   arena:tick          — full leaderboard snapshot every TICK_MS
 *   arena:rank:update   — targeted update when a swarm's rank changes
 */

import { MessageBus, Logger } from "@swarm/shared";

export interface ArenaEntry {
  swarmId: string;
  name: string;
  score: number;
  winRate: number;
  riskAdjustedReturn: number;
  auditTrustScore: number;
  followers: number;
  totalTrades: number;
  isMe?: boolean;
}

export interface ArenaScore {
  swarmId: string;
  score: number;
  rank: number;
  delta: number;
}

interface ExecutionResult {
  swarmId?: string;
  status: "confirmed" | "failed";
  profitUsd?: number;
  riskScore?: number;
}

interface AuditResult {
  swarmId?: string;
  verdict: "approved" | "flagged" | "rejected";
  trustScore?: number;
}

const TICK_MS = parseInt(process.env["ARENA_TICK_MS"] ?? "10000", 10);

export class ArenaScorer {
  private bus: MessageBus;
  private log: Logger;
  private swarms = new Map<string, ArenaEntry>();
  private previousRanks = new Map<string, number>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(bus: MessageBus, log: Logger) {
    this.bus = bus;
    this.log = log;
  }

  async start(): Promise<void> {
    this.log.info("ArenaScorer starting");

    // Subscribe to execution results
    await this.bus.subscribe("swarm:execution:update", (payload: unknown) => {
      this.onExecution(payload as ExecutionResult);
    });

    // Subscribe to VeriAgent audit completions
    await this.bus.subscribe("verifier:audit:complete", (payload: unknown) => {
      this.onAudit(payload as AuditResult);
    });

    // Periodic leaderboard tick
    this.tickTimer = setInterval(() => this.publishLeaderboard(), TICK_MS);

    this.log.info({ tickMs: TICK_MS }, "ArenaScorer running");
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** Register a swarm identity (called on registry:identity:registered) */
  registerSwarm(swarmId: string, name: string, isMe = false): void {
    if (!this.swarms.has(swarmId)) {
      this.swarms.set(swarmId, {
        swarmId,
        name,
        score: 0,
        winRate: 0,
        riskAdjustedReturn: 0,
        auditTrustScore: 50,
        followers: 0,
        totalTrades: 0,
        isMe,
      });
    }
  }

  private onExecution(result: ExecutionResult): void {
    const id = result.swarmId ?? "local";
    if (!this.swarms.has(id)) this.registerSwarm(id, `Swarm-${id.slice(0, 6)}`);
    const entry = this.swarms.get(id)!;

    entry.totalTrades++;
    const won = result.status === "confirmed" && (result.profitUsd ?? 0) > 0;
    const wins = Math.round(entry.winRate * (entry.totalTrades - 1)) + (won ? 1 : 0);
    entry.winRate = wins / entry.totalTrades;

    if (result.profitUsd != null) {
      const riskFactor = result.riskScore ?? 0.5;
      entry.riskAdjustedReturn =
        (entry.riskAdjustedReturn * 0.9) + ((result.profitUsd / (riskFactor + 0.1)) * 0.1);
    }

    entry.score = this.computeScore(entry);
    this.log.debug({ swarmId: id, score: entry.score }, "Arena score updated");
  }

  private onAudit(result: AuditResult): void {
    const id = result.swarmId ?? "local";
    if (!this.swarms.has(id)) this.registerSwarm(id, `Swarm-${id.slice(0, 6)}`);
    const entry = this.swarms.get(id)!;

    if (result.trustScore != null) {
      entry.auditTrustScore = result.trustScore;
    } else {
      const delta = result.verdict === "approved" ? 2 : result.verdict === "flagged" ? -1 : -5;
      entry.auditTrustScore = Math.min(100, Math.max(0, entry.auditTrustScore + delta));
    }
    entry.score = this.computeScore(entry);
  }

  private computeScore(entry: ArenaEntry): number {
    return (
      entry.winRate * 50 +
      Math.min(50, Math.max(-20, entry.riskAdjustedReturn)) * 30 / 50 +
      entry.auditTrustScore * 20 / 100
    );
  }

  private async publishLeaderboard(): Promise<void> {
    if (this.swarms.size === 0) return;

    const sorted = [...this.swarms.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // Detect rank changes
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i]!;
      const newRank = i + 1;
      const prevRank = this.previousRanks.get(entry.swarmId);
      if (prevRank !== newRank) {
        await this.bus.publish("arena:rank:update", {
          swarmId: entry.swarmId,
          rank: newRank,
          score: entry.score,
          winRate: entry.winRate,
          followers: entry.followers,
          delta: prevRank != null ? prevRank - newRank : 0,
        });
        this.previousRanks.set(entry.swarmId, newRank);
      }
    }

    await this.bus.publish("arena:tick", { leaderboard: sorted });
  }
}
