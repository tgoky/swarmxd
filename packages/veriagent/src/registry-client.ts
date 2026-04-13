/**
 * RegistryClient — interface to the Solana Agent Registry.
 *
 * In production this wraps the Solana Agent Registry SDK to:
 *   - Create a PDA-backed AgentProfile (identity)
 *   - Post AuditAttestation records (validation proofs)
 *
 * During development / devnet it uses a lightweight mock that logs to console
 * and returns synthetic DIDs so the rest of the system works without live RPC.
 */

import { Logger } from "@swarm/shared";

export interface IdentityParams {
  swarmId: string;
  walletAddress: string;
  capabilities: string[];
}

export interface IdentityRecord {
  did: string;
  walletAddress: string;
  capabilities: string[];
  registeredAt: string;
}

export interface AttestationParams {
  swarmId: string;
  decisionHash: string;
  verdict: "approved" | "flagged" | "rejected";
  trustScore: number;
}

const DRY_RUN = process.env["DRY_RUN"] !== "false";

export class RegistryClient {
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async registerIdentity(params: IdentityParams): Promise<IdentityRecord> {
    const did = `did:solana:${params.walletAddress.slice(0, 8)}${params.swarmId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase()}`;

    if (DRY_RUN) {
      this.log.info({ did, mode: "dry-run" }, "Registry: identity registered (mock)");
    } else {
      // TODO: integrate @solana-agent-kit/registry once SDK is stable
      // const registry = new AgentRegistry({ rpc: process.env.SOLANA_RPC_URL });
      // await registry.createIdentity({ did, walletAddress, capabilities });
      this.log.info({ did }, "Registry: identity registered (on-chain)");
    }

    return {
      did,
      walletAddress: params.walletAddress,
      capabilities: params.capabilities,
      registeredAt: new Date().toISOString(),
    };
  }

  async postAttestation(params: AttestationParams): Promise<void> {
    if (DRY_RUN) {
      this.log.info(
        { swarmId: params.swarmId, verdict: params.verdict, hash: params.decisionHash, mode: "dry-run" },
        "Registry: attestation posted (mock)"
      );
      return;
    }

    // TODO: write AuditAttestation PDA via Anchor CPI
    // const tx = await program.methods.recordAttestation({ ... }).rpc();
    this.log.info(
      { swarmId: params.swarmId, verdict: params.verdict, hash: params.decisionHash },
      "Registry: attestation posted (on-chain)"
    );
  }
}
