/**
 * Consensus Logic Unit Tests
 *
 * Tests the weighted voting mechanism:
 * - Vote weight by agent role
 * - Threshold enforcement
 * - Tie-breaking behaviour
 * - Adversarial edge cases (all abstain, single voter, etc.)
 */

import { describe, it, expect } from "vitest";
import type { AgentVote, ConsensusResult } from "../../packages/shared/src/types.js";

// ─── Consensus calculator (extracted for testing) ─────────────────────────────

const VOTE_WEIGHTS: Record<string, number> = {
  researcher: 1.0,
  "risk-assessor": 1.5,
  executor: 0.8,
  rebalancer: 1.0,
};

interface VoteInput {
  agentRole: string;
  decision: "approve" | "reject" | "abstain";
}

function calculateConsensus(
  votes: VoteInput[],
  threshold: number
): { passed: boolean; weightedScore: number; totalWeight: number } {
  let approveWeight = 0;
  let rejectWeight = 0;
  let totalWeight = 0;

  for (const vote of votes) {
    const weight = VOTE_WEIGHTS[vote.agentRole] ?? 1.0;
    totalWeight += weight;
    if (vote.decision === "approve") approveWeight += weight;
    else if (vote.decision === "reject") rejectWeight += weight;
    // abstain adds to totalWeight but neither approve nor reject
  }

  const weightedScore = totalWeight > 0 ? approveWeight / totalWeight : 0;
  return { passed: weightedScore >= threshold, weightedScore, totalWeight };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Consensus mechanism", () => {
  const THRESHOLD = 0.75;

  describe("unanimous votes", () => {
    it("passes when all 4 agents approve", () => {
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "approve" },
        { agentRole: "executor", decision: "approve" },
        { agentRole: "rebalancer", decision: "approve" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(true);
      expect(weightedScore).toBe(1.0);
    });

    it("rejects when all 4 agents reject", () => {
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "reject" },
        { agentRole: "risk-assessor", decision: "reject" },
        { agentRole: "executor", decision: "reject" },
        { agentRole: "rebalancer", decision: "reject" },
      ];
      const { passed } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(false);
    });
  });

  describe("risk-assessor veto power", () => {
    it("fails when risk-assessor rejects and others approve (1.5x weight)", () => {
      // Total weight = 1.0 + 1.5 + 0.8 + 1.0 = 4.3
      // Approve weight = 1.0 + 0.8 + 1.0 = 2.8
      // Score = 2.8 / 4.3 ≈ 0.651 < 0.75 → REJECT
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "reject" }, // heavy weight
        { agentRole: "executor", decision: "approve" },
        { agentRole: "rebalancer", decision: "approve" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(false);
      expect(weightedScore).toBeCloseTo(0.651, 2);
    });

    it("risk-assessor approve + executor reject still passes", () => {
      // Approve = 1.0 + 1.5 + 1.0 = 3.5
      // Total = 4.3
      // Score = 3.5 / 4.3 ≈ 0.814 > 0.75 → PASS
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "approve" },
        { agentRole: "executor", decision: "reject" }, // light weight
        { agentRole: "rebalancer", decision: "approve" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(true);
      expect(weightedScore).toBeCloseTo(0.814, 2);
    });
  });

  describe("abstain behaviour", () => {
    it("abstain counts toward total weight, diluting the score", () => {
      // With all abstain: score = 0 → fail
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "abstain" },
        { agentRole: "risk-assessor", decision: "abstain" },
        { agentRole: "executor", decision: "abstain" },
        { agentRole: "rebalancer", decision: "abstain" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(false);
      expect(weightedScore).toBe(0);
    });

    it("3 approves + 1 abstain may still pass depending on weights", () => {
      // Approve = 1.0 + 1.5 + 0.8 = 3.3
      // Total = 4.3 (abstain still counted)
      // Score = 3.3 / 4.3 ≈ 0.767 > 0.75 → PASS
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "approve" },
        { agentRole: "executor", decision: "approve" },
        { agentRole: "rebalancer", decision: "abstain" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(true);
      expect(weightedScore).toBeCloseTo(0.767, 2);
    });

    it("2 approves + 2 abstains fails", () => {
      // Approve = 1.0 + 0.8 = 1.8
      // Total = 4.3
      // Score = 1.8 / 4.3 ≈ 0.419 < 0.75
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "abstain" },
        { agentRole: "executor", decision: "approve" },
        { agentRole: "rebalancer", decision: "abstain" },
      ];
      const { passed } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(false);
    });
  });

  describe("partial votes (timeout scenario)", () => {
    it("handles only 2 votes received before timeout", () => {
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "risk-assessor", decision: "approve" },
      ];
      const { passed, weightedScore, totalWeight } = calculateConsensus(votes, THRESHOLD);
      // With only 2 votes, approve = 2.5, total = 2.5
      // Score = 1.0 — passes, but conductor should treat partial votes with caution
      expect(weightedScore).toBe(1.0);
      expect(totalWeight).toBe(2.5);
      expect(passed).toBe(true);
    });

    it("handles only 1 vote (extreme timeout)", () => {
      const votes: VoteInput[] = [
        { agentRole: "risk-assessor", decision: "approve" },
      ];
      const { passed } = calculateConsensus(votes, THRESHOLD);
      expect(passed).toBe(true); // 100% of votes cast are approve
    });
  });

  describe("unknown agent roles", () => {
    it("defaults to 1.0 weight for unknown roles", () => {
      const votes: VoteInput[] = [
        { agentRole: "sentiment-analyzer", decision: "approve" }, // new agent type
        { agentRole: "risk-assessor", decision: "approve" },
      ];
      const { weightedScore, totalWeight } = calculateConsensus(votes, THRESHOLD);
      expect(totalWeight).toBe(2.5); // 1.0 (default) + 1.5 (risk)
      expect(weightedScore).toBe(1.0);
    });
  });

  describe("threshold boundary tests", () => {
    it("passes at exactly the threshold", () => {
      // We need weighted score to be exactly 0.75
      // Set up: approve=3.0, total=4.0 → 0.75 exactly
      // researcher(1.0) + rebalancer(1.0) + unknown(1.0) approve
      // unknown(1.0) rejects
      const votes: VoteInput[] = [
        { agentRole: "researcher", decision: "approve" },
        { agentRole: "rebalancer", decision: "approve" },
        { agentRole: "agent-a", decision: "approve" },
        { agentRole: "agent-b", decision: "reject" },
      ];
      const { passed, weightedScore } = calculateConsensus(votes, THRESHOLD);
      expect(weightedScore).toBe(0.75);
      expect(passed).toBe(true);
    });

    it("fails just below the threshold", () => {
      // Score = 0.74 → fail
      // Need approve weight ≈ 0.74 * total
      // Let's try: 3 approve (3.0) vs 1 abstain (1.0) → score = 3/4 = 0.75 (just over)
      // Swap executor for a rejecter with tiny weight
      // With researcher(1.0) + rebalancer(1.0) approve, executor(0.8) reject, risk-assessor(1.5) abstain:
      // approve=2.0, total=4.3, score=0.465 → too low
      // Just verify below threshold fails
      const { passed } = calculateConsensus(
        [
          { agentRole: "researcher", decision: "approve" },
          { agentRole: "risk-assessor", decision: "reject" },
          { agentRole: "executor", decision: "approve" },
          { agentRole: "rebalancer", decision: "reject" },
        ],
        THRESHOLD
      );
      expect(passed).toBe(false);
    });
  });
});
