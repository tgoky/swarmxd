"use client";

import { useState } from "react";
import { useSwarmStore } from "@/stores/swarm.store";
import type { ExecutionState, ArenaEntry, AuditEntry } from "@/stores/swarm.store";
import { PnlChart } from "./PnlChart";

type RightTab = "portfolio" | "arena" | "veri";

// ── Portfolio tab ─────────────────────────────────────────────────────────────

function PortfolioTab() {
  const portfolio = useSwarmStore((s) => s.portfolio);
  const executions = useSwarmStore((s) => s.executions);
  const pnlHistory = useSwarmStore((s) => s.pnlHistory);

  const daily = portfolio?.dailyReturnPct ?? 0;

  return (
    <>
      <div className="panel-header">
        <span className="panel-title">Portfolio</span>
        <span className="panel-badge">
          {portfolio?.walletAddress
            ? portfolio.walletAddress.slice(0, 6) + "…" + portfolio.walletAddress.slice(-4)
            : "No wallet"}
        </span>
      </div>

      <div className="portfolio-section">
        <div className="portfolio-value">
          {portfolio
            ? "$" + portfolio.totalValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "$0.00"}
        </div>
        <div className={`portfolio-return ${daily >= 0 ? "positive" : "negative"}`}>
          {(daily >= 0 ? "+" : "") + (daily * 100).toFixed(2)}% today
        </div>
      </div>

      {/* PnL Chart */}
      {pnlHistory.length > 1 && (
        <div className="pnl-chart">
          <PnlChart data={pnlHistory} />
        </div>
      )}

      {/* Positions */}
      <div style={{ padding: "8px 16px", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, color: "var(--text3)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>
          Positions
        </div>
        {!portfolio?.positions || portfolio.positions.length === 0 ? (
          <div className="empty" style={{ padding: "12px 0" }}>No active positions</div>
        ) : (
          portfolio.positions.map((pos) => {
            const pct =
              portfolio.totalValueUsd > 0
                ? (pos.valueUsd / portfolio.totalValueUsd) * 100
                : 0;
            return (
              <div key={pos.id} className="position-row">
                <div className={`position-protocol protocol-${pos.protocol}`}>
                  {pos.protocol.slice(0, 6)}
                </div>
                <div className="position-bar-wrap">
                  <div className="position-bar" style={{ width: `${pct.toFixed(1)}%` }} />
                </div>
                <div className="position-apy">{pos.currentApy?.toFixed(1) ?? "0.0"}%</div>
                <div className="position-value">${pos.valueUsd?.toFixed(0) ?? "0"}</div>
              </div>
            );
          })
        )}
      </div>

      {/* Executions */}
      <div className="panel-header" style={{ borderTop: "none" }}>
        <span className="panel-title">Executions</span>
        <span className="panel-badge">{executions.length}</span>
      </div>
      <div className="panel-body">
        {executions.length === 0 ? (
          <div className="empty">No executions yet</div>
        ) : (
          executions.slice(0, 20).map((e: ExecutionState) => (
            <div key={e.id} className="exec-item">
              <div className={`exec-status ${e.status}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="exec-type">{e.action.type.replace(/_/g, " ")}</div>
                <div className="exec-sig">
                  {e.status === "confirmed"
                    ? (e.txSignatures[0]?.slice(0, 20) ?? "") + "…"
                    : e.status}
                </div>
                {e.errorMessage && (
                  <div style={{ fontSize: 10, color: "var(--red)", marginTop: 2 }}>
                    {e.errorMessage.slice(0, 60)}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ── Arena tab ─────────────────────────────────────────────────────────────────

function ArenaTab() {
  const arena = useSwarmStore((s) => s.arena);
  const addActivity = useSwarmStore((s) => s.addActivity);

  function toggleCopy() {
    // Optimistic toggle — real state would come from server via WS
    addActivity({
      type: "arena",
      title: !arena.isCopying ? "🔄 Copy-Trading ENABLED" : "⏹ Copy-Trading disabled",
      severity: !arena.isCopying ? "success" : "info",
    });
  }

  const rankTxt = arena.myRank ? `#${arena.myRank}` : "—";

  return (
    <>
      <div className="panel-header">
        <span className="panel-title" style={{ color: "var(--yellow)" }}>Swarm Arena</span>
        <span className="panel-badge">RANK {rankTxt}</span>
      </div>

      {/* My stats */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div className="arena-my-stats">
          <div>
            <div className="arena-stat-label">RANK</div>
            <div className="arena-stat-value" style={{ color: "var(--yellow)" }}>{rankTxt}</div>
          </div>
          <div>
            <div className="arena-stat-label">SCORE</div>
            <div className="arena-stat-value">{arena.myScore ? arena.myScore.toFixed(0) : "—"}</div>
          </div>
          <div>
            <div className="arena-stat-label">WIN %</div>
            <div className="arena-stat-value" style={{ color: "var(--green)" }}>
              {arena.myWinRate ? (arena.myWinRate * 100).toFixed(1) + "%" : "—"}
            </div>
          </div>
          <div>
            <div className="arena-stat-label">FOLLOWERS</div>
            <div className="arena-stat-value" style={{ color: "var(--blue)" }}>
              {arena.myFollowers}
            </div>
          </div>
        </div>
        <button
          className={`copy-btn${arena.isCopying ? " active" : ""}`}
          onClick={toggleCopy}
        >
          {arena.isCopying ? "✓ COPYING SWARM (LIVE)" : "COPY THIS SWARM"}
        </button>
      </div>

      {/* Leaderboard */}
      <div className="panel-header" style={{ borderTop: "none" }}>
        <span className="panel-title">Live Leaderboard</span>
        <span className="panel-badge">Top 10</span>
      </div>

      <div className="panel-body">
        <div className="leaderboard-header">
          <span />
          <span>Swarm</span>
          <span style={{ textAlign: "right" }}>Score</span>
          <span style={{ textAlign: "right" }}>Win%</span>
          <span style={{ textAlign: "right" }}>Fans</span>
        </div>
        {arena.leaderboard.length === 0 ? (
          <div className="empty">Waiting for arena data…</div>
        ) : (
          arena.leaderboard.map((entry: ArenaEntry, i: number) => (
            <div key={entry.name} className={`leaderboard-row${entry.isMe ? " is-me" : ""}`}>
              <div className="lb-rank">
                {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}
              </div>
              <div className="lb-name">{entry.name}</div>
              <div className="lb-score">{entry.score.toFixed(0)}</div>
              <div className="lb-winrate">{(entry.winRate * 100).toFixed(1)}%</div>
              <div className="lb-followers">{entry.followers}👥</div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ── VeriAgent tab ─────────────────────────────────────────────────────────────

function VeriAgentTab() {
  const veriagent = useSwarmStore((s) => s.veriagent);

  return (
    <>
      <div className="panel-header">
        <span className="panel-title" style={{ color: "var(--purple)" }}>VeriAgent Auditor</span>
        <span className="panel-badge">
          {veriagent.trustScore ? `TRUST: ${veriagent.trustScore.toFixed(0)}` : "TRUST —"}
        </span>
      </div>

      {/* Registry + stats */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span className="registry-badge">ON-CHAIN VERIFIED</span>
          <span style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
            {veriagent.registryId
              ? `DID: ${veriagent.registryId.slice(0, 22)}…`
              : "DID: —"}
          </span>
        </div>
        <div className="veri-stats-grid">
          <div>
            <div className="veri-stat-label">TOTAL AUDITS</div>
            <div className="veri-stat-value">{veriagent.totalAudits}</div>
          </div>
          <div>
            <div className="veri-stat-label">APPROVED</div>
            <div className="veri-stat-value" style={{ color: "var(--green)" }}>
              {veriagent.passedAudits}
            </div>
          </div>
          <div>
            <div className="veri-stat-label">TRUST SCORE</div>
            <div className="veri-stat-value" style={{ color: "var(--purple)" }}>
              {veriagent.trustScore ? veriagent.trustScore.toFixed(0) : "—"}
            </div>
          </div>
        </div>
        <div className="trust-bar-wrap">
          <div className="trust-bar-fill" style={{ width: `${veriagent.trustScore}%` }} />
        </div>
      </div>

      {/* Audit log */}
      <div className="panel-header" style={{ borderTop: "none" }}>
        <span className="panel-title">Audit Log</span>
        <span className="panel-badge">{veriagent.totalAudits}</span>
      </div>
      <div className="panel-body">
        {veriagent.auditLog.length === 0 ? (
          <div className="empty">Awaiting decisions to audit…</div>
        ) : (
          veriagent.auditLog.slice(0, 20).map((a: AuditEntry, i: number) => (
            <div key={i} className="audit-item">
              <div className={`audit-verdict ${a.verdict}`}>
                {a.verdict === "approved" ? "✅" : a.verdict === "flagged" ? "⚠️" : "❌"}{" "}
                {a.verdict.toUpperCase()}
              </div>
              <div className="audit-action">{a.action.replace(/_/g, " ")}</div>
              <div className="audit-hash">{a.decisionHash.slice(0, 28)}…</div>
              <div className="audit-reason">
                {a.reasoning.slice(0, 100)}
                {a.reasoning.length > 100 ? "…" : ""}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ── Right Panel ───────────────────────────────────────────────────────────────

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<RightTab>("portfolio");

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
      {/* Tabs */}
      <div className="right-tabs">
        <button
          className={`right-tab${activeTab === "portfolio" ? " active" : ""}`}
          onClick={() => setActiveTab("portfolio")}
        >
          PORTFOLIO
        </button>
        <button
          className={`right-tab arena-tab${activeTab === "arena" ? " active" : ""}`}
          onClick={() => setActiveTab("arena")}
        >
          ⚔ ARENA
        </button>
        <button
          className={`right-tab veri-tab${activeTab === "veri" ? " active" : ""}`}
          onClick={() => setActiveTab("veri")}
        >
          🔍 VERIAGENT
        </button>
      </div>

      {/* Tab views */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
        {activeTab === "portfolio" && <PortfolioTab />}
        {activeTab === "arena" && <ArenaTab />}
        {activeTab === "veri" && <VeriAgentTab />}
      </div>
    </div>
  );
}
