use anchor_lang::prelude::*;

declare_id!("SwrmMem11111111111111111111111111111111111111");

/// SwarmMemory — Immutable on-chain decision log for the Swarm Conductor.
///
/// Each call to `record_decision` creates a PDA account storing one
/// hive-mind decision. PDAs are derived from [b"swarm-decision", &seq.to_le_bytes()]
/// making them deterministically addressable and immutable once written.
///
/// Why PDAs instead of compressed NFTs?
/// - PDAs are cheaper for pure data storage (no NFT program overhead)
/// - Deterministically queryable off-chain without indexers
/// - Anchor handles discriminator + serde automatically
///
/// For high-frequency deployments (>1000 trades/day), migrate to:
/// - Solana Ledger (account append only)
/// - Light Protocol compressed accounts (~100x cheaper)
#[program]
pub mod swarm_memory {
    use super::*;

    /// Initialize the global swarm state account.
    /// Called once by the conductor on first deployment.
    pub fn initialize(ctx: Context<Initialize>, swarm_id: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.swarm_state;
        state.authority = ctx.accounts.authority.key();
        state.swarm_id = swarm_id;
        state.total_decisions = 0;
        state.total_pnl_lamports = 0;
        state.created_at = Clock::get()?.unix_timestamp;
        state.bump = ctx.bumps.swarm_state;

        emit!(SwarmInitialized {
            authority: state.authority,
            swarm_id,
            timestamp: state.created_at,
        });

        Ok(())
    }

    /// Record a swarm decision on-chain.
    /// Only callable by the swarm authority (conductor's wallet).
    pub fn record_decision(
        ctx: Context<RecordDecision>,
        params: DecisionParams,
    ) -> Result<()> {
        let state = &mut ctx.accounts.swarm_state;
        let decision = &mut ctx.accounts.decision;

        // Validate sequence number is monotonically increasing
        require!(
            params.sequence_number == state.total_decisions + 1,
            SwarmError::InvalidSequenceNumber
        );

        // Validate consensus hash is 32 bytes
        require!(
            params.consensus_hash.len() == 32,
            SwarmError::InvalidConsensusHash
        );

        // Write decision data
        decision.sequence_number = params.sequence_number;
        decision.swarm_state = ctx.accounts.swarm_state.key();
        decision.signal_id = params.signal_id;
        decision.consensus_hash = params.consensus_hash.try_into().unwrap();
        decision.action_type = params.action_type;
        decision.action_summary = params.action_summary;
        decision.tx_signatures = params.tx_signatures;
        decision.net_pnl_lamports = params.net_pnl_lamports;
        decision.agent_count = params.agent_count;
        decision.approve_weight = params.approve_weight;
        decision.timestamp = Clock::get()?.unix_timestamp;
        decision.bump = ctx.bumps.decision;

        // Update global state
        state.total_decisions += 1;
        state.total_pnl_lamports = state
            .total_pnl_lamports
            .checked_add(params.net_pnl_lamports)
            .unwrap_or(state.total_pnl_lamports);
        state.last_decision_at = decision.timestamp;

        emit!(DecisionRecorded {
            sequence_number: decision.sequence_number,
            consensus_hash: decision.consensus_hash,
            action_type: decision.action_type.clone(),
            net_pnl_lamports: decision.net_pnl_lamports,
            timestamp: decision.timestamp,
        });

        Ok(())
    }

    /// Update PnL for a previously recorded decision (called when position closes).
    pub fn update_pnl(
        ctx: Context<UpdatePnl>,
        sequence_number: u64,
        realized_pnl_lamports: i64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.swarm_state;
        let decision = &mut ctx.accounts.decision;

        require!(
            decision.sequence_number == sequence_number,
            SwarmError::SequenceMismatch
        );

        // Update the decision's PnL
        let old_pnl = decision.net_pnl_lamports;
        decision.net_pnl_lamports = realized_pnl_lamports;

        // Adjust global PnL
        state.total_pnl_lamports = state
            .total_pnl_lamports
            .checked_sub(old_pnl)
            .and_then(|v| v.checked_add(realized_pnl_lamports))
            .unwrap_or(state.total_pnl_lamports);

        Ok(())
    }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + SwarmState::LEN,
        seeds = [b"swarm-state", authority.key().as_ref()],
        bump
    )]
    pub swarm_state: Account<'info, SwarmState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: DecisionParams)]
pub struct RecordDecision<'info> {
    #[account(
        mut,
        seeds = [b"swarm-state", authority.key().as_ref()],
        bump = swarm_state.bump,
        has_one = authority
    )]
    pub swarm_state: Account<'info, SwarmState>,

    #[account(
        init,
        payer = authority,
        space = 8 + DecisionRecord::LEN,
        seeds = [
            b"swarm-decision",
            swarm_state.key().as_ref(),
            &params.sequence_number.to_le_bytes()
        ],
        bump
    )]
    pub decision: Account<'info, DecisionRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence_number: u64)]
pub struct UpdatePnl<'info> {
    #[account(
        mut,
        seeds = [b"swarm-state", authority.key().as_ref()],
        bump = swarm_state.bump,
        has_one = authority
    )]
    pub swarm_state: Account<'info, SwarmState>,

    #[account(
        mut,
        seeds = [
            b"swarm-decision",
            swarm_state.key().as_ref(),
            &sequence_number.to_le_bytes()
        ],
        bump = decision.bump
    )]
    pub decision: Account<'info, DecisionRecord>,

    pub authority: Signer<'info>,
}

// ── State structs ─────────────────────────────────────────────────────────────

#[account]
#[derive(Debug)]
pub struct SwarmState {
    pub authority: Pubkey,       // 32
    pub swarm_id: [u8; 32],      // 32
    pub total_decisions: u64,    // 8
    pub total_pnl_lamports: i64, // 8
    pub created_at: i64,         // 8
    pub last_decision_at: i64,   // 8
    pub bump: u8,                // 1
}

impl SwarmState {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

#[account]
#[derive(Debug)]
pub struct DecisionRecord {
    pub sequence_number: u64,      // 8
    pub swarm_state: Pubkey,        // 32
    pub signal_id: [u8; 16],        // 16  (nanoid 16 chars, stored as bytes)
    pub consensus_hash: [u8; 32],   // 32
    pub action_type: String,        // 4 + 32 (max 32 chars)
    pub action_summary: String,     // 4 + 128 (max 128 chars)
    pub tx_signatures: Vec<String>, // 4 + (4 + 88) * 4 (up to 4 sigs)
    pub net_pnl_lamports: i64,      // 8
    pub agent_count: u8,            // 1
    pub approve_weight: u16,        // 2  (basis points, 10000 = 100%)
    pub timestamp: i64,             // 8
    pub bump: u8,                   // 1
}

impl DecisionRecord {
    // 8 (discriminator) + all fields above with max strings
    pub const LEN: usize = 8 + 32 + 16 + 32 + (4 + 32) + (4 + 128) + (4 + (4 + 88) * 4) + 8 + 1 + 2 + 8 + 1;
}

// ── Instruction params ────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DecisionParams {
    pub sequence_number: u64,
    pub signal_id: [u8; 16],
    pub consensus_hash: Vec<u8>,
    pub action_type: String,
    pub action_summary: String,
    pub tx_signatures: Vec<String>,
    pub net_pnl_lamports: i64,
    pub agent_count: u8,
    pub approve_weight: u16,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct SwarmInitialized {
    pub authority: Pubkey,
    pub swarm_id: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct DecisionRecorded {
    pub sequence_number: u64,
    pub consensus_hash: [u8; 32],
    pub action_type: String,
    pub net_pnl_lamports: i64,
    pub timestamp: i64,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum SwarmError {
    #[msg("Sequence number must be exactly one more than current total")]
    InvalidSequenceNumber,
    #[msg("Consensus hash must be exactly 32 bytes")]
    InvalidConsensusHash,
    #[msg("Decision sequence number does not match")]
    SequenceMismatch,
    #[msg("Action type string too long (max 32 chars)")]
    ActionTypeTooLong,
    #[msg("Action summary too long (max 128 chars)")]
    ActionSummaryTooLong,
}
