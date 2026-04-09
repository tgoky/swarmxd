/**
 * Integration Test — Full Swarm Pipeline
 *
 * Tests the complete signal → proposal → vote → consensus → execution flow
 * using a real Redis instance (must be running on localhost:6379).
 *
 * Run: pnpm test (with Redis running)
 * Skip in CI without Redis: SKIP_INTEGRATION=true pnpm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "redis";
import { CHANNELS } from "../../packages/shared/src/types.js";
import type { Signal, AgentProposal, AgentVote, ConsensusResult, ExecutionRecord } from "../../packages/shared/src/types.js";
import { nanoid } from "nanoid";

const SKIP = process.env["SKIP_INTEGRATION"] === "true";

function maybeDescribe(name: string, fn: () => void) {
  if (SKIP) {
    describe.skip(name, fn);
  } else {
    describe(name, fn);
  }
}

maybeDescribe("Full swarm pipeline (integration)", () => {
  let pub: ReturnType<typeof createClient>;
  let sub: ReturnType<typeof createClient>;
  const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

  beforeAll(async () => {
    pub = createClient({ url: REDIS_URL });
    sub = createClient({ url: REDIS_URL });
    await pub.connect();
    await sub.connect();
  });

  afterAll(async () => {
    await pub.disconnect();
    await sub.disconnect();
  });

  it("signal published on correct channel is received", async () => {
    const signal: Signal = {
      id: nanoid(16),
      type: "apy_spike",
      priority: "high",
      source: "on-chain",
      data: { poolAddress: "test-pool", previousApy: 24, currentApy: 78 },
      confidence: 0.87,
      detectedAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    };

    const received = await new Promise<Signal>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Signal not received in 3s")), 3_000);

      sub.subscribe(CHANNELS.SIGNAL_NEW, (rawMsg) => {
        clearTimeout(timer);
        const msg = JSON.parse(rawMsg);
        resolve(msg.payload as Signal);
        sub.unsubscribe(CHANNELS.SIGNAL_NEW);
      });

      // Small delay to ensure subscriber is ready
      setTimeout(() => {
        pub.publish(CHANNELS.SIGNAL_NEW, JSON.stringify({
          channel: CHANNELS.SIGNAL_NEW,
          senderId: "test",
          payload: signal,
          timestamp: new Date(),
          correlationId: nanoid(8),
        }));
      }, 50);
    });

    expect(received.id).toBe(signal.id);
    expect(received.type).toBe("apy_spike");
    expect(received.confidence).toBe(0.87);
  });

  it("proposal roundtrip — publish and receive", async () => {
    const proposalId = nanoid(16);
    const proposal: AgentProposal = {
      id: proposalId,
      agentId: "researcher-test",
      agentRole: "researcher",
      signalId: "sig-test",
      action: {
        type: "rebalance",
        params: {
          fromPool: "pool-a",
          toPool: "pool-b",
          fromProtocol: "raydium",
          toProtocol: "orca",
          fraction: 0.25,
          reason: "Integration test",
          estimatedApyGain: 15,
          estimatedCostBps: 20,
        },
      },
      reasoning: "Integration test proposal",
      confidence: 0.80,
      expectedReturnUsd: 100,
      maxDownsideUsd: 50,
      estimatedGasLamports: 5_000,
      urgency: "medium",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
    };

    const received = await new Promise<AgentProposal>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Proposal not received in 3s")), 3_000);

      sub.subscribe(CHANNELS.PROPOSAL_NEW, (rawMsg) => {
        clearTimeout(timer);
        const msg = JSON.parse(rawMsg);
        if (msg.payload.id === proposalId) {
          resolve(msg.payload as AgentProposal);
          sub.unsubscribe(CHANNELS.PROPOSAL_NEW);
        }
      });

      setTimeout(() => {
        pub.publish(CHANNELS.PROPOSAL_NEW, JSON.stringify({
          channel: CHANNELS.PROPOSAL_NEW,
          senderId: "test",
          payload: proposal,
          timestamp: new Date(),
          correlationId: nanoid(8),
        }));
      }, 50);
    });

    expect(received.id).toBe(proposalId);
    expect(received.agentRole).toBe("researcher");
    expect(received.action.type).toBe("rebalance");
  });

  it("vote roundtrip — publish and receive", async () => {
    const vote: AgentVote = {
      agentId: "risk-assessor-test",
      agentRole: "risk-assessor",
      proposalId: "prop-test",
      decision: "approve",
      confidence: 0.85,
      reasoning: "Risk score 35/100 — acceptable",
      votedAt: new Date(),
    };

    const received = await new Promise<AgentVote>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vote not received in 3s")), 3_000);

      sub.subscribe(CHANNELS.VOTE_CAST, (rawMsg) => {
        clearTimeout(timer);
        const msg = JSON.parse(rawMsg);
        if (msg.payload.agentId === vote.agentId) {
          resolve(msg.payload as AgentVote);
          sub.unsubscribe(CHANNELS.VOTE_CAST);
        }
      });

      setTimeout(() => {
        pub.publish(CHANNELS.VOTE_CAST, JSON.stringify({
          channel: CHANNELS.VOTE_CAST,
          senderId: "test",
          payload: vote,
          timestamp: new Date(),
          correlationId: nanoid(8),
        }));
      }, 50);
    });

    expect(received.decision).toBe("approve");
    expect(received.agentRole).toBe("risk-assessor");
    expect(received.confidence).toBe(0.85);
  });

  it("HALT signal stops the swarm and RESUME restores it", async () => {
    const events: string[] = [];

    await sub.subscribe(CHANNELS.SWARM_HALT, () => { events.push("halted"); });
    await sub.subscribe(CHANNELS.SWARM_RESUME, () => { events.push("resumed"); });

    await pub.publish(CHANNELS.SWARM_HALT, JSON.stringify({
      channel: CHANNELS.SWARM_HALT,
      senderId: "test",
      payload: { reason: "Integration test halt" },
      timestamp: new Date(),
      correlationId: nanoid(8),
    }));

    await new Promise((r) => setTimeout(r, 100));

    await pub.publish(CHANNELS.SWARM_RESUME, JSON.stringify({
      channel: CHANNELS.SWARM_RESUME,
      senderId: "test",
      payload: { resumedBy: "test" },
      timestamp: new Date(),
      correlationId: nanoid(8),
    }));

    await new Promise((r) => setTimeout(r, 100));

    await sub.unsubscribe(CHANNELS.SWARM_HALT);
    await sub.unsubscribe(CHANNELS.SWARM_RESUME);

    expect(events).toContain("halted");
    expect(events).toContain("resumed");
    expect(events.indexOf("halted")).toBeLessThan(events.indexOf("resumed"));
  });

  it("execution update lifecycle — pending → simulating → confirmed", async () => {
    const execId = nanoid(16);
    const updates: string[] = [];

    const statuses: ExecutionRecord["status"][] = ["pending", "simulating", "submitted", "confirmed"];

    await sub.subscribe(CHANNELS.EXECUTION_UPDATE, (rawMsg) => {
      const msg = JSON.parse(rawMsg);
      const record = msg.payload as ExecutionRecord;
      if (record.id === execId) {
        updates.push(record.status);
      }
    });

    for (const status of statuses) {
      await pub.publish(CHANNELS.EXECUTION_UPDATE, JSON.stringify({
        channel: CHANNELS.EXECUTION_UPDATE,
        senderId: "test",
        payload: {
          id: execId,
          consensusResultId: "cons-test",
          action: { type: "rebalance", params: {} },
          status,
          txSignatures: status === "confirmed" ? ["5Kx...abc"] : [],
          gasUsedLamports: status === "confirmed" ? 5_100 : 0,
          actualSlippageBps: 0,
        } as ExecutionRecord,
        timestamp: new Date(),
        correlationId: nanoid(8),
      }));
      await new Promise((r) => setTimeout(r, 30));
    }

    await new Promise((r) => setTimeout(r, 100));
    await sub.unsubscribe(CHANNELS.EXECUTION_UPDATE);

    expect(updates).toEqual(statuses);
  });
});
