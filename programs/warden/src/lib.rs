use anchor_lang::prelude::*;

declare_id!("2cLztVnAZWxyMUdeuxQAssz85x1ytMbHZJdBcETqfeeT");

// Risk decision thresholds. These are informational conventions consumed by
// off-chain callers and the TypeScript SDK (see sdk/src/decision.ts) - the
// program itself never branches on them, it only stores and authorizes the
// score. Keeping the decision boundary out of the program means we can
// retune thresholds without a new deployment.
//
//   score  [0, ALLOW_MAX)        -> ALLOW
//   score  [ALLOW_MAX, BLOCK_MIN) -> REVIEW
//   score  [BLOCK_MIN, MAX_SCORE] -> BLOCK
pub const ALLOW_MAX: u16 = 300;
pub const BLOCK_MIN: u16 = 700;
pub const MAX_SCORE: u16 = 1000;

// Bitflags packed into RiskAttestation.flags. Mirrored in
// sdk/src/decision.ts - keep both in sync if this changes.
pub const FLAG_SANCTIONED: u32 = 1 << 0;
pub const FLAG_MIXER_PATTERN: u32 = 1 << 1;
pub const FLAG_NEW_WALLET: u32 = 1 << 2;
pub const FLAG_HIGH_VELOCITY: u32 = 1 << 3;
pub const FLAG_LOW_HISTORY: u32 = 1 << 4;

#[program]
pub mod warden {
    use super::*;

    /// One-time setup of the global registry. `admin` can later rotate the
    /// scoring `authority`; `authority` is the only signer allowed to submit
    /// attestations.
    pub fn initialize_registry(
        ctx: Context<InitializeRegistry>,
        admin: Pubkey,
        authority: Pubkey,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.admin = admin;
        registry.authority = authority;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Create or refresh a wallet's risk attestation. Only the current
    /// registry `authority` may call this - it is meant to be invoked by the
    /// off-chain scorer (see offchain/scorer/submit.ts) after it has
    /// computed a fresh score from real transaction history.
    pub fn submit_attestation(
        ctx: Context<SubmitAttestation>,
        wallet: Pubkey,
        risk_score: u16,
        flags: u32,
    ) -> Result<()> {
        require!(risk_score <= MAX_SCORE, WardenError::InvalidScore);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.registry.authority,
            WardenError::Unauthorized
        );

        let attestation = &mut ctx.accounts.attestation;
        attestation.wallet = wallet;
        attestation.risk_score = risk_score;
        attestation.flags = flags;
        attestation.last_updated_slot = Clock::get()?.slot;
        attestation.updated_by = ctx.accounts.authority.key();
        attestation.bump = ctx.bumps.attestation;

        emit!(AttestationSubmitted {
            wallet,
            risk_score,
            flags,
            slot: attestation.last_updated_slot,
        });

        Ok(())
    }

    /// Admin-only rotation of the scoring authority, e.g. to move from a
    /// hackathon demo keypair to a production signing service.
    pub fn rotate_authority(ctx: Context<RotateAuthority>, new_authority: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.admin.key(),
            ctx.accounts.registry.admin,
            WardenError::Unauthorized
        );
        ctx.accounts.registry.authority = new_authority;
        Ok(())
    }
}

#[account]
pub struct Registry {
    pub admin: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
}

impl Registry {
    pub const LEN: usize = 8 + 32 + 32 + 1;
}

#[account]
pub struct RiskAttestation {
    pub wallet: Pubkey,
    pub risk_score: u16,
    pub flags: u32,
    pub last_updated_slot: u64,
    pub updated_by: Pubkey,
    pub bump: u8,
}

impl RiskAttestation {
    pub const LEN: usize = 8 + 32 + 2 + 4 + 8 + 32 + 1;
}

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(
        init,
        payer = payer,
        space = Registry::LEN,
        seeds = [b"registry"],
        bump
    )]
    pub registry: Account<'info, Registry>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct SubmitAttestation<'info> {
    #[account(seeds = [b"registry"], bump = registry.bump)]
    pub registry: Account<'info, Registry>,

    #[account(
        init_if_needed,
        payer = authority,
        space = RiskAttestation::LEN,
        seeds = [b"attestation", wallet.as_ref()],
        bump
    )]
    pub attestation: Account<'info, RiskAttestation>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateAuthority<'info> {
    #[account(mut, seeds = [b"registry"], bump = registry.bump)]
    pub registry: Account<'info, Registry>,

    pub admin: Signer<'info>,
}

#[event]
pub struct AttestationSubmitted {
    pub wallet: Pubkey,
    pub risk_score: u16,
    pub flags: u32,
    pub slot: u64,
}

#[error_code]
pub enum WardenError {
    #[msg("risk_score exceeds the maximum of 1000")]
    InvalidScore,
    #[msg("signer is not authorized for this action")]
    Unauthorized,
}
