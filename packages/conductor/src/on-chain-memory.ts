/**
 * OnChainMemory — Writes the swarm's decisions to Solana PDAs immutably.
 *
 * Each trade decision is recorded on-chain as:
 * - A PDA derived from [swarm-memory, sequence_number]
 * - Contains: signal ID, proposal hash, consensus hash, tx signatures, PnL
 *
 * This creates an auditable, immutable history of every decision the swarm made.
 * Think: a blockchain-native trading journal that can't be tampered with.
 *
 * In production: uses the Anchor program in packages/on-chain/
 * For devnet/demo: writes to a compressed NFT (cheaper) or uses Solana memo program
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { HiveMindEntry, SwarmConfig } from "@swarm/shared";
import type { Logger } from "@swarm/shared";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export class OnChainMemory {
  private connection: Connection;
  private programId?: PublicKey;
  private entries: HiveMindEntry[] = [];

  constructor(
    private readonly config: SwarmConfig,
    private readonly logger: Logger
  ) {
    this.connection = new Connection(config.solana.rpcUrl, { commitment: "confirmed" });
  }

  async initialize(): Promise<void> {
    const programIdStr = process.env["SWARM_MEMORY_PROGRAM_ID"];
    if (programIdStr) {
      this.programId = new PublicKey(programIdStr);
      this.logger.info({ programId: programIdStr }, "On-chain memory program loaded");
    } else {
      this.logger.warn(
        "SWARM_MEMORY_PROGRAM_ID not set — using Memo program fallback (devnet only)"
      );
    }
  }

  /**
   * Write a hive mind decision entry on-chain.
   *
   * Production path: Call the Anchor program's `record_decision` instruction.
   * Devnet/demo path: Write JSON to Solana Memo program (cheap, instant, indexed).
   */
  async writeEntry(entry: HiveMindEntry): Promise<string | null> {
    this.entries.push(entry);

    try {
      if (this.programId) {
        return await this.writeToProgram(entry);
      } else {
        return await this.writeToMemo(entry);
      }
    } catch (err) {
      this.logger.error({ err, entry }, "Failed to write on-chain memory entry");
      return null;
    }
  }

  async getEntries(): Promise<HiveMindEntry[]> {
    return [...this.entries];
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async writeToProgram(entry: HiveMindEntry): Promise<string> {
    // This calls the deployed Anchor program
    // See packages/on-chain/programs/swarm-memory/ for the Rust code
    throw new Error("Anchor program write not implemented in this scaffold — deploy the program first");
  }

  private async writeToMemo(entry: HiveMindEntry): Promise<string | null> {
    const walletKey = process.env["WALLET_PRIVATE_KEY"];
    if (!walletKey) {
      this.logger.warn("No wallet key — skipping on-chain memo write");
      return null;
    }

    const payer = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(walletKey) as number[])
    );

    const memoText = JSON.stringify({
      v: 1,                              // schema version
      seq: entry.sequenceNumber,
      sig: entry.consensusHash,
      action: entry.actionSummary,
      pnl: entry.netPnlUsd,
      ts: entry.timestamp,
    });

    const ix = new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoText, "utf-8"),
    });

    const tx = new Transaction().add(ix);

    try {
      const sig = await sendAndConfirmTransaction(this.connection, tx, [payer]);
      this.logger.info({ sig, seq: entry.sequenceNumber }, "Decision recorded on-chain via Memo");
      return sig;
    } catch (err) {
      this.logger.error({ err }, "Memo write failed");
      return null;
    }
  }
}
