/**
 * BaseAgent — Abstract foundation for all swarm agents.
 *
 * Every agent (Researcher, RiskAssessor, Executor, Rebalancer) extends this.
 * Handles: lifecycle, heartbeat, bus subscription, error isolation.
 */

import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import type { AgentRole, AgentMetadata, AgentProposal, AgentVote, Signal, SwarmConfig } from "./types.js";
import { CHANNELS } from "./types.js";
import { MessageBus } from "./message-bus.js";
import { createLogger, type Logger } from "./logger.js";

export interface AgentDependencies {
  bus: MessageBus;
  config: SwarmConfig;
  anthropicApiKey: string;
}

export abstract class BaseAgent {
  readonly id: string;
  readonly role: AgentRole;
  protected readonly bus: MessageBus;
  protected readonly config: SwarmConfig;
  protected readonly logger: Logger;
  protected readonly ai: Anthropic;
  protected status: AgentMetadata["status"] = "idle" as const;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(role: AgentRole, deps: AgentDependencies) {
    this.id = `${role}-${nanoid(8)}`;
    this.role = role;
    this.bus = deps.bus;
    this.config = deps.config;
    this.logger = createLogger({ agentRole: role, agentId: this.id });
    this.ai = new Anthropic({ apiKey: deps.anthropicApiKey });
  }

  async start(): Promise<void> {
    this.logger.info("Agent starting");

    // Subscribe to relevant channels
    this.bus.subscribe(CHANNELS.SIGNAL_NEW, async (msg) => {
      try {
        await this.onSignal(msg.payload as Signal);
      } catch (err) {
        this.logger.error({ err }, "Error handling signal");
      }
    });

    this.bus.subscribe(CHANNELS.SWARM_HALT, async () => {
      this.logger.warn("Received HALT signal — stopping agent");
      await this.stop();
    });

    // Additional subscriptions specific to each agent
    await this.registerSubscriptions();

    // Heartbeat every 10s
    this.heartbeatInterval = setInterval(async () => {
      await this.bus.publish(CHANNELS.AGENT_HEARTBEAT, {
        agentId: this.id,
        role: this.role,
        status: this.status,
        timestamp: new Date(),
      });
    }, 10_000);

    await this.onStart();
    this.logger.info("Agent ready");
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeatInterval);
    await this.onStop();
    this.logger.info("Agent stopped");
  }

  // ── Abstract hooks ────────────────────────────────────────────────────────

  /**
   * Called once when the agent starts. Override for initialization logic.
   */
  protected abstract onStart(): Promise<void>;

  /**
   * Called when the agent receives a new market signal.
   * Each agent decides whether this signal is relevant to its role.
   */
  protected abstract onSignal(signal: Signal): Promise<void>;

  /**
   * Register additional bus subscriptions beyond the base ones.
   */
  protected abstract registerSubscriptions(): Promise<void>;

  /**
   * Called on graceful shutdown.
   */
  protected async onStop(): Promise<void> {}

  // ── AI helper ─────────────────────────────────────────────────────────────

  /**
   * Convenience wrapper for Claude completions with consistent system prompting.
   * Agents use this for all analytical reasoning.
   */
  protected async think(
    systemPrompt: string,
    userPrompt: string,
    maxTokens = 2048
  ): Promise<string> {
    const response = await this.ai.messages.create({
      model: process.env["ANTHROPIC_MODEL"] ?? "claude-opus-4-5",
      max_tokens: maxTokens,
      system: `You are the ${this.role} agent in a decentralized DeFi trading swarm called Swarm Conductor.
Your role: ${this.getRoleDescription()}
Current time: ${new Date().toISOString()}
Always respond with structured, actionable analysis. Be precise about numbers and risk.
${systemPrompt}`,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AI returned no text content");
    }

    return textBlock.text;
  }

  protected abstract getRoleDescription(): string;

  // ── Proposal helpers ──────────────────────────────────────────────────────

  protected async submitProposal(
    proposal: Omit<AgentProposal, "id" | "agentId" | "agentRole" | "createdAt">
  ): Promise<void> {
    const full: AgentProposal = {
      ...proposal,
      id: nanoid(16),
      agentId: this.id,
      agentRole: this.role,
      createdAt: new Date(),
    };

    this.logger.info(
      { proposalId: full.id, action: full.action.type, confidence: full.confidence },
      "Submitting proposal"
    );

    await this.bus.publish(CHANNELS.PROPOSAL_NEW, full);
  }

  protected async castVote(vote: Omit<AgentVote, "agentId" | "agentRole" | "votedAt">): Promise<void> {
    const full: AgentVote = {
      ...vote,
      agentId: this.id,
      agentRole: this.role,
      votedAt: new Date(),
    };

    await this.bus.publish(CHANNELS.VOTE_CAST, full);
  }
}
