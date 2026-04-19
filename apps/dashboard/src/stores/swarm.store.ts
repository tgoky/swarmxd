/**
 * Swarm state store — Zustand
 * Populated via WebSocket connection to the API server.
 * Covers Swarm Conductor + Arena + VeriAgent channels.
 */

import { create } from "zustand";

export interface AgentState {
  agentId: string;
  role: string;
  status: string;
  lastHeartbeat: string;
}

export interface SignalState {
  id: string;
  type: string;
  priority: "low" | "medium" | "high" | "critical";
  source: string;
  confidence: number;
  data: Record<string, unknown>;
  detectedAt: string;
}

export interface ProposalState {
  id: string;
  agentRole: string;
  action: { type: string; params: Record<string, unknown> };
  reasoning: string;
  confidence: number;
  expectedReturnUsd: number;
  maxDownsideUsd: number;
  urgency: string;
  createdAt: string;
  votes?: VoteState[];
}

export interface VoteState {
  agentId: string;
  agentRole: string;
  decision: "approve" | "reject" | "abstain";
  confidence: number;
  reasoning: string;
}

export interface ExecutionState {
  id: string;
  action: { type: string };
  status: string;
  txSignatures: string[];
  gasUsedLamports: number;
  errorMessage?: string;
  submittedAt?: string;
  confirmedAt?: string;
}

export interface PortfolioState {
  walletAddress: string;
  totalValueUsd: number;
  idleUsdc: number;
  positions: PositionState[];
  dailyReturnPct: number;
  allTimeReturnPct: number;
  lastUpdated: string;
}

export interface PositionState {
  id: string;
  protocol: string;
  poolAddress: string;
  valueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  currentApy: number;
}

export interface SwarmStore {
  // Connection
  connected: boolean;
  lastPing: Date | null;

  // Swarm state
  isHalted: boolean;
  haltReason?: string;
  agents: Record<string, AgentState>;

  // Market data
  portfolio: PortfolioState | null;
  signals: SignalState[];
  proposals: ProposalState[];
  executions: ExecutionState[];

  // Vault deposits (user-initiated on-chain deposits)
  vaultBalance: number;        // total SOL deposited
  vaultDeposits: VaultDeposit[];

  // Chart data
  pnlHistory: { timestamp: number; valueUsd: number }[];

  // Activity feed
  activityFeed: ActivityItem[];

  // Arena
  arena: ArenaState;

  // VeriAgent
  veriagent: VeriAgentState;

  // Actions
  setConnected: (v: boolean) => void;
  applyMessage: (channel: string, payload: unknown) => void;
  addActivity: (item: Omit<ActivityItem, "id" | "timestamp">) => void;
}

export interface ActivityItem {
  id: string;
  timestamp: Date;
  type: "signal" | "proposal" | "vote" | "execution" | "consensus" | "halt" | "heartbeat" | "arena" | "veriagent";
  agentRole?: string;
  title: string;
  detail?: string;
  severity: "info" | "success" | "warning" | "error";
}

export interface VaultDeposit {
  walletAddress: string;
  amountSol: number;
  txSignature: string;
  timestamp: string;
}

// ── Arena ─────────────────────────────────────────────────────────────────────

export interface ArenaEntry {
  name: string;
  score: number;
  winRate: number;
  followers: number;
  isMe?: boolean;
}

export interface ArenaState {
  myRank: number | null;
  myScore: number;
  myWinRate: number;
  myFollowers: number;
  isCopying: boolean;
  leaderboard: ArenaEntry[];
}

// ── VeriAgent ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  verdict: "approved" | "flagged" | "rejected";
  action: string;
  decisionHash: string;
  reasoning: string;
  trustScore?: number;
  timestamp: string;
}

export interface VeriAgentState {
  registryId: string | null;
  trustScore: number;
  totalAudits: number;
  passedAudits: number;
  auditLog: AuditEntry[];
}

let activitySeq = 0;

export const useSwarmStore = create<SwarmStore>((set, get) => ({
  connected: false,
  lastPing: null,
  isHalted: false,
  agents: {},
  portfolio: null,
  signals: [],
  proposals: [],
  executions: [],
  vaultBalance: 0,
  vaultDeposits: [],
  pnlHistory: [],
  activityFeed: [],
  arena: {
    myRank: null,
    myScore: 0,
    myWinRate: 0,
    myFollowers: 0,
    isCopying: false,
    leaderboard: [],
  },
  veriagent: {
    registryId: null,
    trustScore: 0,
    totalAudits: 0,
    passedAudits: 0,
    auditLog: [],
  },

  setConnected: (v) => set({ connected: v }),

  addActivity: (item) => {
    const full: ActivityItem = {
      ...item,
      id: String(++activitySeq),
      timestamp: new Date(),
    };
    set((s) => ({
      activityFeed: [full, ...s.activityFeed].slice(0, 200),
    }));
  },

  applyMessage: (channel, payload) => {
    const { addActivity } = get();
    const p = payload as Record<string, unknown>;

    switch (channel) {
      case "swarm:portfolio:update":
        set({ portfolio: p as unknown as PortfolioState });
        // Track PnL history
        set((s) => ({
          pnlHistory: [
            ...s.pnlHistory,
            { timestamp: Date.now(), valueUsd: (p["totalValueUsd"] as number) ?? 0 },
          ].slice(-288), // 24h at 5-min intervals
        }));
        break;

      case "swarm:signal:new": {
        const sig = p as unknown as SignalState;
        set((s) => ({ signals: [sig, ...s.signals].slice(0, 50) }));
        addActivity({
          type: "signal",
          title: `Signal: ${sig.type.replace(/_/g, " ")}`,
          detail: `${sig.priority} priority • ${(sig.confidence * 100).toFixed(0)}% confidence`,
          severity: sig.priority === "critical" ? "error" : sig.priority === "high" ? "warning" : "info",
        });
        break;
      }

      case "swarm:proposal:new": {
        const prop = p as unknown as ProposalState;
        set((s) => ({ proposals: [prop, ...s.proposals].slice(0, 50) }));
        addActivity({
          type: "proposal",
          agentRole: prop.agentRole,
          title: `${prop.agentRole} proposed ${prop.action.type}`,
          detail: `Confidence ${(prop.confidence * 100).toFixed(0)}% • Expected +$${prop.expectedReturnUsd?.toFixed(2) ?? "0"}`,
          severity: "info",
        });
        break;
      }

      case "swarm:vote:cast": {
        const vote = p as unknown as VoteState & { proposalId: string };
        // Attach vote to proposal
        set((s) => ({
          proposals: s.proposals.map((pr) =>
            pr.id === vote.proposalId
              ? { ...pr, votes: [...(pr.votes ?? []), vote] }
              : pr
          ),
        }));
        addActivity({
          type: "vote",
          agentRole: vote.agentRole,
          title: `${vote.agentRole} voted ${vote.decision}`,
          detail: vote.reasoning,
          severity: vote.decision === "reject" ? "warning" : vote.decision === "approve" ? "success" : "info",
        });
        break;
      }

      case "swarm:consensus:reached": {
        const result = p as { passed: boolean; proposalId: string; weightedScore: number; finalAction?: { type: string } };
        addActivity({
          type: "consensus",
          title: result.passed ? "✅ Consensus PASSED" : "❌ Consensus REJECTED",
          detail: `${(result.weightedScore * 100).toFixed(0)}% approval • ${result.finalAction?.type ?? "no action"}`,
          severity: result.passed ? "success" : "warning",
        });
        break;
      }

      case "swarm:execution:update": {
        const exec = p as unknown as ExecutionState;
        set((s) => {
          const existing = s.executions.findIndex((e) => e.id === exec.id);
          const updated = existing >= 0
            ? s.executions.map((e, i) => i === existing ? exec : e)
            : [exec, ...s.executions].slice(0, 100);
          return { executions: updated };
        });
        if (exec.status === "confirmed") {
          addActivity({
            type: "execution",
            title: `Execution confirmed: ${exec.action.type}`,
            detail: `Tx: ${exec.txSignatures[0]?.slice(0, 16)}...`,
            severity: "success",
          });
        } else if (exec.status === "failed") {
          addActivity({
            type: "execution",
            title: `Execution FAILED: ${exec.action.type}`,
            detail: exec.errorMessage,
            severity: "error",
          });
        }
        break;
      }

      case "swarm:agent:heartbeat": {
        const hb = p as AgentState;
        set((s) => ({ agents: { ...s.agents, [hb.agentId]: hb } }));
        break;
      }

      case "swarm:halt":
        set({ isHalted: true, haltReason: (p["reason"] as string) ?? "Unknown" });
        addActivity({ type: "halt", title: "🚨 SWARM HALTED", detail: p["reason"] as string, severity: "error" });
        break;

      case "swarm:resume":
        set({ isHalted: false, haltReason: undefined });
        addActivity({ type: "halt", title: "✅ Swarm Resumed", severity: "success" });
        break;

      case "state:snapshot": {
        const snap = p as Partial<SwarmStore & { agents: Record<string, AgentState> }>;
        set({
          portfolio: (snap.portfolio as PortfolioState) ?? null,
          signals: (snap.signals as SignalState[]) ?? [],
          proposals: (snap.proposals as ProposalState[]) ?? [],
          executions: (snap.executions as ExecutionState[]) ?? [],
          agents: snap.agents ?? {},
          isHalted: snap.isHalted ?? false,
          ...(snap.arena ? { arena: snap.arena } : {}),
          ...(snap.veriagent ? { veriagent: snap.veriagent } : {}),
        });
        break;
      }

      // ── Arena ─────────────────────────────────────────────────
      case "arena:tick": {
        const tick = p as { leaderboard?: ArenaEntry[] };
        if (tick.leaderboard) {
          set((s) => ({ arena: { ...s.arena, leaderboard: tick.leaderboard! } }));
        }
        break;
      }

      case "arena:rank:update": {
        const rank = p as { rank: number; score?: number; winRate?: number; followers?: number };
        set((s) => ({
          arena: {
            ...s.arena,
            myRank: rank.rank,
            myScore: rank.score ?? s.arena.myScore,
            myWinRate: rank.winRate ?? s.arena.myWinRate,
            myFollowers: rank.followers ?? s.arena.myFollowers,
          },
        }));
        addActivity({
          type: "arena",
          title: `Arena Rank: #${rank.rank}`,
          detail: `Score ${(rank.score ?? 0).toFixed(0)} • ${rank.followers ?? 0} followers`,
          severity: "success",
        });
        break;
      }

      // ── VeriAgent ──────────────────────────────────────────────
      case "verifier:audit:complete": {
        const audit = p as AuditEntry;
        set((s) => {
          const passed = audit.verdict === "approved" ? s.veriagent.passedAudits + 1 : s.veriagent.passedAudits;
          const total = s.veriagent.totalAudits + 1;
          return {
            veriagent: {
              ...s.veriagent,
              totalAudits: total,
              passedAudits: passed,
              trustScore: audit.trustScore ?? (passed / total) * 100,
              auditLog: [audit, ...s.veriagent.auditLog].slice(0, 50),
            },
          };
        });
        addActivity({
          type: "veriagent",
          title: `Audit ${audit.verdict.toUpperCase()}: ${audit.action}`,
          detail: `Hash: ${audit.decisionHash.slice(0, 20)}…`,
          severity: audit.verdict === "approved" ? "success" : audit.verdict === "flagged" ? "warning" : "error",
        });
        break;
      }

      case "swarm:deposit:confirmed": {
        const dep = p as VaultDeposit;
        set((s) => ({
          vaultBalance: s.vaultBalance + dep.amountSol,
          vaultDeposits: [
            { ...dep, timestamp: dep.timestamp ?? new Date().toISOString() },
            ...s.vaultDeposits,
          ].slice(0, 50),
        }));
        addActivity({
          type: "execution",
          title: `Deposit received: ${dep.amountSol} SOL`,
          detail: `From ${dep.walletAddress.slice(0, 8)}… · Tx: ${dep.txSignature.slice(0, 16)}…`,
          severity: "success",
        });
        break;
      }

      case "registry:identity:registered": {
        const reg = p as { did: string };
        set((s) => ({ veriagent: { ...s.veriagent, registryId: reg.did } }));
        addActivity({
          type: "veriagent",
          title: "Registry Identity Established",
          detail: `DID: ${reg.did.slice(0, 24)}…`,
          severity: "success",
        });
        break;
      }
    }
  },
}));
