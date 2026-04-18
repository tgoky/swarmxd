/**
 * VerifierAgent — VeriAgent's core auditor.
 *
 * Listens for swarm:consensus:reached events. For each approved proposal that
 * executes, it:
 *   1. Hashes the decision (action + reasoning + votes + timestamp)
 *   2. Runs a secondary Claude check to detect strategy misalignment
 *   3. Publishes verifier:audit:complete with verdict + reasoning + hash
 *   4. Syncs the result to the Solana Agent Registry via RegistryClient
 *
 * Published channels:
 *   verifier:audit:complete     — audit result with verdict + hash
 *   registry:identity:registered — fired once on startup after PDA creation
 */

import crypto from "crypto";
import OpenAI from "openai";
import { MessageBus, Logger } from "@swarm/shared";
import { RegistryClient } from "./registry-client.js";

export type AuditVerdict = "approved" | "flagged" | "rejected";

export interface AuditResult {
  swarmId: string;
  action: string;
  decisionHash: string;
  verdict: AuditVerdict;
  reasoning: string;
  trustScore: number;
  timestamp: string;
}

export interface RegistryIdentity {
  did: string;
  walletAddress: string;
  capabilities: string[];
  registeredAt: string;
}

interface ConsensusPayload {
  passed: boolean;
  proposalId: string;
  weightedScore: number;
  finalAction?: { type: string; params?: Record<string, unknown> };
  reasoning?: string;
  votes?: Array<{ agentRole: string; decision: string; reasoning: string }>;
}

const STRATEGY_SYSTEM_PROMPT = `You are VeriAgent, an on-chain AI auditor for autonomous DeFi swarms.
Your job is to verify that a proposed trade action aligns with the swarm's declared strategy and is free of:
- Front-running patterns
- Strategy drift (deviating from declared objectives)
- Concentration risk exceeding limits
- Anomalous reasoning (hallucinations or circular logic)

Respond with a JSON object:
{
  "verdict": "approved" | "flagged" | "rejected",
  "reasoning": "<concise 1-2 sentence explanation>",
  "trustDelta": <number between -10 and +5>
}

Be concise. Be strict but fair. Only reject if there is a clear violation.`;

export class VerifierAgent {
  private bus: MessageBus;
  private log: Logger;
  private registry: RegistryClient;
  private client: OpenAI;
  private trustScore = 80;
  private swarmId: string;
  private auditsCompleted = 0;
  private auditsPassed = 0;

  constructor(bus: MessageBus, log: Logger, registry: RegistryClient) {
    this.bus = bus;
    this.log = log;
    this.registry = registry;
    this.client = new OpenAI({
      baseURL: process.env["LLM_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey: process.env["OPENROUTER_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"] ?? "",
      defaultHeaders: {
        "HTTP-Referer": "https://swarmconductor.xyz",
        "X-Title": "Swarm Conductor — VeriAgent",
      },
    });
    this.swarmId = process.env["SWARM_ID"] ?? "local-swarm";
  }

  async start(): Promise<void> {
    this.log.info("VerifierAgent starting");

    // Register identity on-chain
    const identity = await this.registry.registerIdentity({
      swarmId: this.swarmId,
      capabilities: ["trading", "rebalancing", "yield-farming"],
      walletAddress: process.env["WALLET_PUBLIC_KEY"] ?? "unknown",
    });

    await this.bus.publish("registry:identity:registered", {
      did: identity.did,
      walletAddress: identity.walletAddress,
      capabilities: identity.capabilities,
      registeredAt: identity.registeredAt,
    });

    // Listen for consensus reached events
    await this.bus.subscribe("swarm:consensus:reached", (payload: unknown) => {
      const consensus = payload as ConsensusPayload;
      if (consensus.passed && consensus.finalAction) {
        // Run audit asynchronously — don't block consensus flow
        this.auditDecision(consensus).catch((err: unknown) => {
          this.log.error({ err }, "VeriAgent audit error");
        });
      }
    });

    this.log.info({ did: identity.did }, "VeriAgent registered + listening");
  }

  private async auditDecision(consensus: ConsensusPayload): Promise<void> {
    const action = consensus.finalAction!;
    const decisionHash = this.hashDecision(consensus);

    this.log.info({ action: action.type, hash: decisionHash }, "Auditing decision");

    try {
      const result = await this.runAuditCheck(consensus);
      this.trustScore = Math.min(100, Math.max(0, this.trustScore + result.trustDelta));
      this.auditsCompleted++;
      if (result.verdict === "approved") this.auditsPassed++;

      const auditResult: AuditResult = {
        swarmId: this.swarmId,
        action: action.type,
        decisionHash,
        verdict: result.verdict,
        reasoning: result.reasoning,
        trustScore: this.trustScore,
        timestamp: new Date().toISOString(),
      };

      // Publish to bus (dashboard receives this)
      await this.bus.publish("verifier:audit:complete", auditResult);

      // Post attestation to Solana Agent Registry
      await this.registry.postAttestation({
        swarmId: this.swarmId,
        decisionHash,
        verdict: result.verdict,
        trustScore: this.trustScore,
      });

      this.log.info({ verdict: result.verdict, trustScore: this.trustScore }, "Audit complete");
    } catch (err) {
      this.log.error({ err }, "Audit check failed");
    }
  }

  private async runAuditCheck(
    consensus: ConsensusPayload
  ): Promise<{ verdict: AuditVerdict; reasoning: string; trustDelta: number }> {
    const action = consensus.finalAction!;
    const userPrompt = `
Action proposed: ${action.type}
Action params: ${JSON.stringify(action.params ?? {})}
Reasoning from agents: ${consensus.reasoning ?? "(not provided)"}
Vote breakdown: ${JSON.stringify(consensus.votes ?? [])}
Weighted approval score: ${(consensus.weightedScore * 100).toFixed(1)}%
`.trim();

    const response = await this.client.chat.completions.create({
      model: process.env["LLM_MODEL"] ?? "anthropic/claude-haiku-4",
      max_tokens: 256,
      messages: [
        { role: "system", content: STRATEGY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";

    try {
      const parsed = JSON.parse(text) as {
        verdict: AuditVerdict;
        reasoning: string;
        trustDelta: number;
      };
      return {
        verdict: parsed.verdict,
        reasoning: parsed.reasoning,
        trustDelta: parsed.trustDelta ?? 0,
      };
    } catch {
      // LLM returned non-JSON — default to flagged
      return {
        verdict: "flagged",
        reasoning: "Audit system could not parse LLM response. Flagging for manual review.",
        trustDelta: -1,
      };
    }
  }

  private hashDecision(consensus: ConsensusPayload): string {
    const data = JSON.stringify({
      action: consensus.finalAction,
      score: consensus.weightedScore,
      timestamp: Date.now(),
    });
    return "0x" + crypto.createHash("sha256").update(data).digest("hex").slice(0, 32);
  }
}