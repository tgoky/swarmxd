"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

interface DepositModalProps {
  onClose: () => void;
}

const VAULT_ADDRESS = process.env["NEXT_PUBLIC_VAULT_ADDRESS"] ?? "";
const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

export function DepositModal({ onClose }: DepositModalProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "confirming" | "done" | "error">("idle");
  const [txSig, setTxSig] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!publicKey) return;
    connection.getBalance(publicKey).then((lamports) => {
      setBalance(lamports / LAMPORTS_PER_SOL);
    }).catch(() => {});
  }, [publicKey, connection]);

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !VAULT_ADDRESS || !amount) return;
    const sol = parseFloat(amount);
    if (isNaN(sol) || sol <= 0) return;

    try {
      setStatus("sending");
      setError("");

      const vaultPubkey = new PublicKey(VAULT_ADDRESS);
      const lamports = Math.floor(sol * LAMPORTS_PER_SOL);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: vaultPubkey,
          lamports,
        })
      );

      const sig = await sendTransaction(tx, connection);
      setTxSig(sig);
      setStatus("confirming");

      await connection.confirmTransaction(sig, "confirmed");

      // Fire-and-forget — notify backend so it can update the portfolio snapshot
      fetch(`${API_URL}/api/v1/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          amountSol: sol,
          txSignature: sig,
        }),
      }).catch(() => {});

      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStatus("error");
    }
  }, [publicKey, amount, connection, sendTransaction]);

  const sol = parseFloat(amount);
  const isValidAmount = !isNaN(sol) && sol > 0 && (balance === null || sol <= balance);
  const canDeposit = Boolean(VAULT_ADDRESS) && isValidAmount && status === "idle";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Deposit to Swarm Vault</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {!VAULT_ADDRESS && (
          <div className="modal-warn">
            Set <code>NEXT_PUBLIC_VAULT_ADDRESS</code> in your .env to enable deposits.
          </div>
        )}

        {status === "done" ? (
          <div className="modal-success">
            <div className="modal-success-icon">✓</div>
            <div className="modal-success-text">Deposit confirmed</div>
            <div className="modal-success-sub">{parseFloat(amount).toFixed(4)} SOL deposited to vault</div>
            <a
              className="modal-explorer-link"
              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on Solana Explorer →
            </a>
            <button className="modal-btn-primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="modal-field">
              <label className="modal-label">Amount (SOL)</label>
              <input
                className="modal-input"
                type="number"
                min="0.001"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={status !== "idle"}
              />
              {balance !== null && (
                <div className="modal-balance">
                  Balance: {balance.toFixed(4)} SOL
                  <button
                    className="modal-max"
                    onClick={() => setAmount(Math.max(0, balance - 0.001).toFixed(4))}
                    disabled={status !== "idle"}
                  >
                    MAX
                  </button>
                </div>
              )}
            </div>

            <div className="modal-field">
              <label className="modal-label">Vault Address (Devnet)</label>
              <div className="modal-vault-addr">
                {VAULT_ADDRESS
                  ? `${VAULT_ADDRESS.slice(0, 12)}…${VAULT_ADDRESS.slice(-8)}`
                  : "Not configured"}
              </div>
            </div>

            <div className="modal-note">
              Network: Solana Devnet · Funds are managed autonomously by the swarm
            </div>

            {error && <div className="modal-error">{error}</div>}

            {status === "confirming" && (
              <div className="modal-confirming">Confirming on-chain…</div>
            )}

            <button
              className="modal-btn-primary"
              onClick={() => void handleDeposit()}
              disabled={!canDeposit}
            >
              {status === "sending"
                ? "Waiting for wallet approval…"
                : status === "confirming"
                ? "Confirming…"
                : "Confirm & Deposit"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
