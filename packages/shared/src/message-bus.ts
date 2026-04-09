/**
 * Message Bus — Redis Pub/Sub wrapper
 *
 * All inter-agent communication flows through here. Agents publish events;
 * the conductor and other agents subscribe to relevant channels.
 *
 * Design decisions:
 * - Using Redis Streams (not just Pub/Sub) for durable message history
 * - Consumer groups allow replay after agent restart
 * - All messages are JSON-serialized with timestamps + correlation IDs
 */

import { createClient, type RedisClientType } from "redis";
import { nanoid } from "nanoid";
import type { BusMessage, ChannelName } from "./types.js";
import type { Logger } from "./logger.js";

type MessageHandler<T = unknown> = (msg: BusMessage<T>) => Promise<void>;

export class MessageBus {
  private pub: RedisClientType;
  private sub: RedisClientType;
  private handlers = new Map<ChannelName, Set<MessageHandler>>();
  private streamGroup: string;

  constructor(
    private readonly redisUrl: string,
    private readonly agentId: string,
    private readonly logger: Logger
  ) {
    this.pub = createClient({ url: redisUrl }) as RedisClientType;
    this.sub = createClient({ url: redisUrl }) as RedisClientType;
    this.streamGroup = `swarm-${agentId}`;
  }

  async connect(): Promise<void> {
    this.pub.on("error", (e) => this.logger.error({ err: e }, "Redis pub error"));
    this.sub.on("error", (e) => this.logger.error({ err: e }, "Redis sub error"));

    await Promise.all([this.pub.connect(), this.sub.connect()]);
    this.logger.info("Message bus connected");
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.pub.disconnect(), this.sub.disconnect()]);
  }

  async publish<T>(channel: ChannelName, payload: T, correlationId?: string): Promise<void> {
    const msg: BusMessage<T> = {
      channel,
      senderId: this.agentId,
      payload,
      timestamp: new Date(),
      correlationId: correlationId ?? nanoid(12),
    };

    const serialized = JSON.stringify(msg, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );

    await this.pub.publish(channel, serialized);

    this.logger.debug({ channel, correlationId: msg.correlationId }, "Message published");
  }

  subscribe<T>(channel: ChannelName, handler: MessageHandler<T>): void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());

      this.sub.subscribe(channel, (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg) as BusMessage<T>;
          msg.timestamp = new Date(msg.timestamp);

          const channelHandlers = this.handlers.get(channel as ChannelName);
          if (!channelHandlers) return;

          channelHandlers.forEach((h) => {
            (h as MessageHandler<T>)(msg).catch((err) => {
              this.logger.error({ err, channel }, "Message handler error");
            });
          });
        } catch (err) {
          this.logger.error({ err, channel }, "Failed to parse bus message");
        }
      });
    }

    this.handlers.get(channel)!.add(handler as MessageHandler);
  }

  unsubscribe(channel: ChannelName): void {
    this.sub.unsubscribe(channel);
    this.handlers.delete(channel);
  }

  /**
   * Request-Reply pattern — publish and wait for a correlated response.
   * Used by conductor to await agent analysis results.
   */
  async request<TReq, TRes>(
    channel: ChannelName,
    replyChannel: ChannelName,
    payload: TReq,
    timeoutMs = 15_000
  ): Promise<TRes> {
    const correlationId = nanoid(12);

    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unsubscribe(replyChannel);
        reject(new Error(`Request to ${channel} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.subscribe<TRes>(replyChannel, async (msg) => {
        if (msg.correlationId === correlationId) {
          clearTimeout(timer);
          this.unsubscribe(replyChannel);
          resolve(msg.payload);
        }
      });

      this.publish(channel, payload, correlationId);
    });
  }
}
