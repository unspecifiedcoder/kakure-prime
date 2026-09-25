use solana_program::program_error::ProgramError;

/// Exact error set from the frozen interface I-3 in
/// docs/superpowers/plans/2026-09-05-kakure-master-plan.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolError {
    Paused,
    InvalidPublicInputCount,
    ComplianceKeyStale,
    StaleRoot,
    NullifierSpent,
    InvalidProof,
    InvalidLeaf,
    AmountMismatch,
    AssetMismatch,
    AssetCollision,
    RecipientMismatch,
    IntentHashNotZero,
    UnsupportedMint,
    VerifierUnset,
}

impl From<PoolError> for ProgramError {
    fn from(e: PoolError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
