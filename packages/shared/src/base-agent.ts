/**
 * BaseAgent — Abstract foundation for all swarm agents.
 *
 * Every agent (Researcher, RiskAssessor, Executor, Rebalancer) extends this.
 * Handles: lifecycle, heartbeat, bus subscription, error isolation.
 */

import OpenAI from "openai";
import { nanoid } from "nanoid";
import type { AgentRole, AgentMetadata, AgentProposal, AgentVote, Signal, SwarmConfig } from "./types.js";
import { CHANNELS } from "./types.js";
import { MessageBus } from "./message-bus.js";
import { createLogger, type Logger } from "./logger.js";

export interface AgentDependencies {
  bus: MessageBus;
  config: SwarmConfig;
  /** Accept either OPENROUTER_API_KEY or ANTHROPIC_API_KEY */
  llmApiKey: string;
}

export abstract class BaseAgent {
  readonly id: string;
  readonly role: AgentRole;
  protected readonly bus: MessageBus;
  protected readonly config: SwarmConfig;
  protected readonly logger: Logger;
  protected readonly ai: OpenAI;
  protected status: AgentMetadata["status"] = "idle" as const;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(role: AgentRole, deps: AgentDependencies) {
    this.id = `${role}-${nanoid(8)}`;
    this.role = role;
    this.bus = deps.bus;
    this.config = deps.config;
    this.logger = createLogger({ agentRole: role, agentId: this.id });
    this.ai = new OpenAI({
      baseURL: process.env["LLM_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey: deps.llmApiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://swarmconductor.xyz",
        "X-Title": "Swarm Conductor",
      },
    });
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
    const model =
      process.env["LLM_MODEL"] ??
      "anthropic/claude-sonnet-4";   // OpenRouter model ID

    const response = await this.ai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "system",
          content: `You are the ${this.role} agent in a decentralized DeFi trading swarm called Swarm Conductor.
Your role: ${this.getRoleDescription()}
Current time: ${new Date().toISOString()}
Always respond with structured, actionable analysis. Be precise about numbers and risk.
${systemPrompt}`,
        },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error("LLM returned no content");
    return text;
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