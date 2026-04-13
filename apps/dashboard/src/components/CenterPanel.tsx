"use client";

import { useSwarmStore } from "@/stores/swarm.store";
import type { ProposalState, VoteState, ActivityItem } from "@/stores/swarm.store";

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar() {
  const portfolio = useSwarmStore((s) => s.portfolio);
  const executions = useSwarmStore((s) => s.executions);

  const dailyReturn = portfolio?.dailyReturnPct ?? 0;
  const tradesCount = executions.filter((e) => e.status === "confirmed").length;
  const avgApy =
    portfolio?.positions && portfolio.positions.length > 0
      ? (
          portfolio.positions.reduce((sum, p) => sum + (p.currentApy ?? 0), 0) /
          portfolio.positions.length
        ).toFixed(1) + "%"
      : "—";

  return (
    <div className="stats-bar">
      <div className="stat neutral">
        <div className="stat-label">Portfolio Value</div>
        <div className="stat-value">
          {portfolio
            ? "$" + portfolio.totalValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "$0"}
        </div>
        <div className="stat-sub">
          Idle: ${(portfolio?.idleUsdc ?? 0).toFixed(2)}
        </div>
      </div>

      <div className={`stat ${dailyReturn >= 0 ? "positive" : "negative"}`}>
        <div className="stat-label">24h Return</div>
        <div className={`stat-value ${dailyReturn >= 0 ? "positive" : "negative"}`}>
          {(dailyReturn >= 0 ? "+" : "") + (dailyReturn * 100).toFixed(2) + "%"}
        </div>
        <div className="stat-sub">
          All-time: {(portfolio?.allTimeReturnPct ?? 0) >= 0 ? "+" : ""}
          {((portfolio?.allTimeReturnPct ?? 0) * 100).toFixed(1)}%
        </div>
      </div>

      <div className="stat neutral">
        <div className="stat-label">Trades Today</div>
        <div className="stat-value">{tradesCount}</div>
        <div className="stat-sub">Executed</div>
      </div>

      <div className="stat neutral">
        <div className="stat-label">Win Rate</div>
        <div className="stat-value">
          {tradesCount > 0
            ? (
                (executions.filter(
                  (e) => e.status === "confirmed" && !e.errorMessage
                ).length /
                  tradesCount) *
                100
              ).toFixed(0) + "%"
            : "—"}
        </div>
        <div className="stat-sub">Last {tradesCount} trades</div>
      </div>

      <div className="stat neutral">
        <div className="stat-label">Avg APY</div>
        <div className="stat-value">{avgApy}</div>
        <div className="stat-sub">Across positions</div>
      </div>
    </div>
  );
}

// ── Proposal list ─────────────────────────────────────────────────────────────

function VoteChips({ votes }: { votes: VoteState[] }) {
  const approves = votes.filter((v) => v.decision === "approve");
  const rejects = votes.filter((v) => v.decision === "reject");
  const abstains = votes.filter((v) => v.decision === "abstain");

  if (votes.length === 0) {
    return <span style={{ color: "var(--text3)", fontSize: 10 }}>Awaiting votes…</span>;
  }

  return (
    <>
      {approves.map((v) => (
        <div key={v.agentId} className="vote-chip approve">✓ {v.agentRole}</div>
      ))}
      {rejects.map((v) => (
        <div key={v.agentId} className="vote-chip reject">✗ {v.agentRole}</div>
      ))}
      {abstains.map((v) => (
        <div key={v.agentId} className="vote-chip abstain">~ {v.agentRole}</div>
      ))}
    </>
  );
}

function ProposalCard({ proposal }: { proposal: ProposalState }) {
  const votes = proposal.votes ?? [];

  return (
    <div className="proposal-card">
      <div className="proposal-header">
        <span className={`proposal-agent ${proposal.agentRole}`}>{proposal.agentRole}</span>
        <span className="tag" style={{ color: urgencyColor(proposal.urgency) }}>
          {proposal.urgency}
        </span>
      </div>
      <div className="proposal-action">
        {proposal.action.type.replace(/_/g, " ")}
      </div>
      <div className="proposal-reasoning">
        {proposal.reasoning?.slice(0, 120)}
        {(proposal.reasoning?.length ?? 0) > 120 ? "…" : ""}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--text3)", marginBottom: 6 }}>
        <span>
          Expected:{" "}
          <span style={{ color: "var(--green)" }}>
            +${proposal.expectedReturnUsd?.toFixed(2) ?? "0"}
          </span>
        </span>
        <span>
          Downside:{" "}
          <span style={{ color: "var(--red)" }}>
            -${proposal.maxDownsideUsd?.toFixed(2) ?? "0"}
          </span>
        </span>
        <span>Conf: {(proposal.confidence * 100).toFixed(0)}%</span>
      </div>
      <div className="vote-bar">
        <VoteChips votes={votes} />
      </div>
      <div className="confidence-bar">
        <div
          className="confidence-fill"
          style={{ width: `${(proposal.confidence * 100).toFixed(0)}%` }}
        />
      </div>
    </div>
  );
}

// ── Activity feed ─────────────────────────────────────────────────────────────

function ActivityItem({ item }: { item: ActivityItem }) {
  const time = item.timestamp instanceof Date
    ? item.timestamp.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";

  return (
    <div className="feed-item">
      <div className={`feed-dot ${item.severity}`} />
      <div className="feed-content">
        <div className="feed-title">{item.title}</div>
        {item.detail && <div className="feed-detail">{item.detail}</div>}
      </div>
      <div className="feed-time">{time}</div>
    </div>
  );
}

// ── Center Panel ──────────────────────────────────────────────────────────────

export function CenterPanel() {
  const proposals = useSwarmStore((s) => s.proposals);
  const activityFeed = useSwarmStore((s) => s.activityFeed);

  return (
    <div className="center-panel">
      <StatsBar />

      {/* Proposals */}
      <div className="panel-header">
        <span className="panel-title">Active Proposals &amp; Consensus</span>
        <span className="panel-badge">{proposals.length} pending</span>
      </div>

      <div
        className="panel-body"
        style={{ flex: 1, overflowY: "auto", padding: 12 }}
      >
        {proposals.length === 0 ? (
          <div className="empty">Awaiting proposals…</div>
        ) : (
          proposals
            .slice(0, 8)
            .map((p) => <ProposalCard key={p.id} proposal={p} />)
        )}
      </div>

      {/* Activity feed */}
      <div style={{
        height: 220,
        borderTop: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}>
        <div className="panel-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="panel-title">Activity Feed</span>
        </div>
        <div className="panel-body" style={{ padding: "6px 8px" }}>
          {activityFeed.length === 0 ? (
            <div className="empty">Listening for events…</div>
          ) : (
            activityFeed
              .slice(0, 30)
              .map((a) => <ActivityItem key={a.id} item={a} />)
          )}
        </div>
      </div>
    </div>
  );
}

function urgencyColor(u: string) {
  return (
    { critical: "var(--red)", high: "var(--yellow)", medium: "var(--blue)", low: "var(--text3)" }[u] ??
    "var(--text3)"
  );
}
