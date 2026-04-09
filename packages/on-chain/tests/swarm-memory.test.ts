/**
 * Swarm Memory Program — Integration Tests
 *
 * Tests the full lifecycle of the on-chain decision log:
 * 1. Initialize swarm state
 * 2. Record multiple decisions
 * 3. Update PnL on closed positions
 * 4. Verify immutability (can't overwrite sequence numbers)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import type { SwarmMemory } from "../target/types/swarm_memory";

describe("swarm-memory", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwarmMemory as Program<SwarmMemory>;
  const authority = provider.wallet as anchor.Wallet;

  let swarmStatePda: PublicKey;
  let swarmStateBump: number;

  const swarmId = Array.from({ length: 32 }, (_, i) => i); // deterministic test ID

  before(async () => {
    [swarmStatePda, swarmStateBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("swarm-state"), authority.publicKey.toBuffer()],
      program.programId
    );
  });

  // ── Initialize ──────────────────────────────────────────────────────────────

  it("initializes the swarm state", async () => {
    const tx = await program.methods
      .initialize(swarmId)
      .accounts({
        swarmState: swarmStatePda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Initialize tx:", tx);

    const state = await program.account.swarmState.fetch(swarmStatePda);

    assert.equal(state.authority.toBase58(), authority.publicKey.toBase58());
    assert.deepEqual(state.swarmId, swarmId);
    assert.equal(state.totalDecisions.toNumber(), 0);
    assert.equal(state.totalPnlLamports.toNumber(), 0);
    assert.equal(state.bump, swarmStateBump);
  });

  // ── Record decisions ─────────────────────────────────────────────────────────

  it("records the first decision with sequence number 1", async () => {
    const seq = new BN(1);
    const signalId = Array.from({ length: 16 }, (_, i) => i + 1);
    const consensusHash = Array.from({ length: 32 }, (_, i) => i);

    const [decisionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swarm-decision"),
        swarmStatePda.toBuffer(),
        seq.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const tx = await program.methods
      .recordDecision({
        sequenceNumber: seq,
        signalId,
        consensusHash,
        actionType: "rebalance",
        actionSummary: "Rotated 40% from Raydium to Meteora — APY gain +44%",
        txSignatures: ["5Kx1abc2def3..."],
        netPnlLamports: new BN(0),
        agentCount: 4,
        approveWeight: 9300, // 93% in basis points
      })
      .accounts({
        swarmState: swarmStatePda,
        decision: decisionPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Record decision tx:", tx);

    const decision = await program.account.decisionRecord.fetch(decisionPda);
    const state = await program.account.swarmState.fetch(swarmStatePda);

    assert.equal(decision.sequenceNumber.toNumber(), 1);
    assert.equal(decision.actionType, "rebalance");
    assert.equal(decision.agentCount, 4);
    assert.equal(decision.approveWeight, 9300);
    assert.equal(state.totalDecisions.toNumber(), 1);
  });

  it("records a second decision sequentially", async () => {
    const seq = new BN(2);
    const signalId = Array.from({ length: 16 }, (_, i) => i + 10);
    const consensusHash = Array.from({ length: 32 }, (_, i) => i + 5);

    const [decisionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swarm-decision"),
        swarmStatePda.toBuffer(),
        seq.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .recordDecision({
        sequenceNumber: seq,
        signalId,
        consensusHash,
        actionType: "harvest_rewards",
        actionSummary: "Harvested $42 in pending rewards across 3 positions",
        txSignatures: ["5Kx9xyz8wvu7..."],
        netPnlLamports: new BN(42_000_000), // $42 in lamports-equivalent
        agentCount: 4,
        approveWeight: 10000,
      })
      .accounts({
        swarmState: swarmStatePda,
        decision: decisionPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.swarmState.fetch(swarmStatePda);
    assert.equal(state.totalDecisions.toNumber(), 2);
    assert.equal(state.totalPnlLamports.toNumber(), 42_000_000);
  });

  it("rejects out-of-sequence decision numbers", async () => {
    const seq = new BN(99); // Should be 3
    const signalId = Array.from({ length: 16 }, () => 0);
    const consensusHash = Array.from({ length: 32 }, () => 0);

    const [decisionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swarm-decision"),
        swarmStatePda.toBuffer(),
        seq.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    try {
      await program.methods
        .recordDecision({
          sequenceNumber: seq,
          signalId,
          consensusHash,
          actionType: "hold",
          actionSummary: "No action taken",
          txSignatures: [],
          netPnlLamports: new BN(0),
          agentCount: 4,
          approveWeight: 0,
        })
        .accounts({
          swarmState: swarmStatePda,
          decision: decisionPda,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      assert.fail("Should have thrown InvalidSequenceNumber");
    } catch (err: unknown) {
      const error = err as { error?: { errorCode?: { code?: string } } };
      assert.include(
        error?.error?.errorCode?.code ?? String(err),
        "InvalidSequenceNumber"
      );
    }
  });

  // ── Update PnL ────────────────────────────────────────────────────────────────

  it("updates PnL on a closed position", async () => {
    const seq = new BN(1);

    const [decisionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swarm-decision"),
        swarmStatePda.toBuffer(),
        seq.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const realizedPnl = new BN(128_500_000); // $128.50 realized

    await program.methods
      .updatePnl(seq, realizedPnl)
      .accounts({
        swarmState: swarmStatePda,
        decision: decisionPda,
        authority: authority.publicKey,
      })
      .rpc();

    const decision = await program.account.decisionRecord.fetch(decisionPda);
    assert.equal(decision.netPnlLamports.toNumber(), 128_500_000);

    // Global PnL should reflect the update
    const state = await program.account.swarmState.fetch(swarmStatePda);
    // Was 42M (from decision 2), now +128.5M from updated decision 1
    assert.equal(state.totalPnlLamports.toNumber(), 128_500_000 + 42_000_000);
  });

  it("verifies PDA is deterministically addressable", async () => {
    // Anyone can compute the address of any decision without the conductor
    const seq = new BN(1);
    const [computed] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("swarm-decision"),
        swarmStatePda.toBuffer(),
        seq.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const decision = await program.account.decisionRecord.fetch(computed);
    assert.equal(decision.sequenceNumber.toNumber(), 1);
    assert.equal(decision.actionType, "rebalance");

    console.log("✅ Decision 1 is publicly queryable at PDA:", computed.toBase58());
  });
});
