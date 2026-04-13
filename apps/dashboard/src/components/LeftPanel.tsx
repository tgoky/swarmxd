"use client";

import { useSwarmStore } from "@/stores/swarm.store";
import type { AgentState, SignalState } from "@/stores/swarm.store";

// ── Agent orb ────────────────────────────────────────────────────────────────

const AGENT_CONFIG: Record<string, { icon: string; label: string; isConductor?: boolean }> = {
  conductor:      { icon: "🎼", label: "Conductor",  isConductor: true },
  researcher:     { icon: "🔭", label: "Researcher" },
  "risk-assessor":{ icon: "🛡",  label: "Risk"       },
  executor:       { icon: "⚡", label: "Executor"   },
  rebalancer:     { icon: "⚖",  label: "Rebalancer" },
};

function AgentOrb({ agent }: { agent: AgentState | undefined; role: string }) {
  const status = agent?.status ?? "idle";
  return (
    <div className={`agent-orb ${status}`} aria-label={status} />
  );
}

function AgentNode({ role, agent }: { role: string; agent?: AgentState }) {
  const cfg = AGENT_CONFIG[role]!;
  const status = agent?.status ?? "idle";

  return (
    <div className={`agent-node${cfg.isConductor ? " conductor-node" : ""}`}>
      <div className={`agent-orb ${status}`}>{cfg.icon}</div>
      <div className={`agent-label${cfg.isConductor ? "" : ""}`}
        style={cfg.isConductor ? { color: "var(--cyan)", fontSize: "11px" } : undefined}>
        {cfg.label}
      </div>
      <div className="agent-status-text">{status}</div>
    </div>
  );
}

// ── Signal card ───────────────────────────────────────────────────────────────

function SignalCard({ signal }: { signal: SignalState }) {
  return (
    <div className={`signal-card ${signal.priority}`}>
      <div className="signal-type">{signal.type.replace(/_/g, " ")}</div>
      <div className="signal-meta">
        <span className="tag">{signal.source}</span>
        <span className="tag">{(signal.confidence * 100).toFixed(0)}% conf</span>
        <span className="tag" style={{ color: priorityColor(signal.priority) }}>
          {signal.priority}
        </span>
      </div>
    </div>
  );
}

function priorityColor(p: string) {
  return (
    { critical: "var(--red)", high: "var(--yellow)", medium: "var(--blue)", low: "var(--text3)" }[p] ??
    "var(--text3)"
  );
}

// ── Left Panel ────────────────────────────────────────────────────────────────

export function LeftPanel() {
  const agents = useSwarmStore((s) => s.agents);
  const signals = useSwarmStore((s) => s.signals);

  const activeCount = Object.keys(agents).length;
  const agentList = Object.values(agents);

  const findAgent = (role: string) =>
    agentList.find((a) => a.role === role);

  const ROLES = ["conductor", "researcher", "risk-assessor", "executor", "rebalancer"] as const;

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
      {/* Agent constellation */}
      <div className="panel-header">
        <span className="panel-title">Swarm Agents</span>
        <span className="panel-badge">{activeCount} active</span>
      </div>

      <div style={{
        padding: "16px 12px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: "8px",
          alignItems: "end",
        }}>
          {ROLES.map((role) => (
            <AgentNode key={role} role={role} agent={findAgent(role)} />
          ))}
        </div>
      </div>

      {/* Signals */}
      <div className="panel-header" style={{ borderTop: "none" }}>
        <span className="panel-title">Live Signals</span>
        <span className="panel-badge">{signals.length}</span>
      </div>

      <div className="panel-body">
        {signals.length === 0 ? (
          <div className="empty">Monitoring on-chain…</div>
        ) : (
          signals.slice(0, 20).map((s) => <SignalCard key={s.id} signal={s} />)
        )}
      </div>
    </div>
  );
}
