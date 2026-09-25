//! Account layouts (frozen interface I-2). Since Anchor could not run on this
//! toolchain (see README/plan deviation note), these are hand-rolled,
//! fixed-offset, zero-copy-style layouts operated on directly over the raw
//! account byte slice (no intermediate struct clone), which keeps compute
//! usage low and preserves the *field order and sizes* Anchor's zero_copy
//! `Pool` would have produced.

use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

pub const TREE_DEPTH: usize = 32;
pub const ROOT_RING: usize = 256;
pub const NUM_VERIFIERS: usize = 7;

// ---- Pool -------------------------------------------------------------
// authority(32) paused(1) compliance_version(4) compliance_pk_x(32)
// compliance_pk_y(32) verifiers(7*32=224) next_leaf_index(8)
// side_nodes(32*32=1024) root_cursor(1) roots(256*32=8192)
pub const POOL_SEED: &[u8] = b"pool";

const OFF_AUTHORITY: usize = 0;
const OFF_PAUSED: usize = 32;
const OFF_COMPLIANCE_VERSION: usize = 33;
const OFF_COMPLIANCE_PK_X: usize = 37;
const OFF_COMPLIANCE_PK_Y: usize = 69;
const OFF_VERIFIERS: usize = 101;
const OFF_NEXT_LEAF_INDEX: usize = OFF_VERIFIERS + NUM_VERIFIERS * 32; // 325
const OFF_SIDE_NODES: usize = OFF_NEXT_LEAF_INDEX + 8; // 333
const OFF_ROOT_CURSOR: usize = OFF_SIDE_NODES + TREE_DEPTH * 32; // 1357
const OFF_ROOTS: usize = OFF_ROOT_CURSOR + 1; // 1358
pub const POOL_LEN: usize = OFF_ROOTS + ROOT_RING * 32; // 9550

pub struct Pool<'a> {
    pub data: &'a mut [u8],
}

impl<'a> Pool<'a> {
    pub fn new(data: &'a mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != POOL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn authority(&self) -> Pubkey {
        Pubkey::try_from(&self.data[OFF_AUTHORITY..OFF_AUTHORITY + 32]).unwrap()
    }
    pub fn set_authority(&mut self, k: &Pubkey) {
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + 32].copy_from_slice(k.as_ref());
    }

    pub fn paused(&self) -> bool {
        self.data[OFF_PAUSED] != 0
    }
    pub fn set_paused(&mut self, v: bool) {
        self.data[OFF_PAUSED] = v as u8;
    }

    pub fn compliance_version(&self) -> u32 {
        u32::from_le_bytes(self.data[OFF_COMPLIANCE_VERSION..OFF_COMPLIANCE_VERSION + 4].try_into().unwrap())
    }
    pub fn set_compliance_version(&mut self, v: u32) {
        self.data[OFF_COMPLIANCE_VERSION..OFF_COMPLIANCE_VERSION + 4].copy_from_slice(&v.to_le_bytes());
    }

    pub fn compliance_pk_x(&self) -> [u8; 32] {
        self.data[OFF_COMPLIANCE_PK_X..OFF_COMPLIANCE_PK_X + 32].try_into().unwrap()
    }
    pub fn compliance_pk_y(&self) -> [u8; 32] {
        self.data[OFF_COMPLIANCE_PK_Y..OFF_COMPLIANCE_PK_Y + 32].try_into().unwrap()
    }
    pub fn set_compliance_pk(&mut self, x: &[u8; 32], y: &[u8; 32]) {
        self.data[OFF_COMPLIANCE_PK_X..OFF_COMPLIANCE_PK_X + 32].copy_from_slice(x);
        self.data[OFF_COMPLIANCE_PK_Y..OFF_COMPLIANCE_PK_Y + 32].copy_from_slice(y);
    }

    pub fn verifier(&self, circuit_id: u8) -> Result<Pubkey, ProgramError> {
        if circuit_id as usize >= NUM_VERIFIERS {
            return Err(ProgramError::InvalidArgument);
        }
        let start = OFF_VERIFIERS + circuit_id as usize * 32;
        Ok(Pubkey::try_from(&self.data[start..start + 32]).unwrap())
    }
    pub fn set_verifier(&mut self, circuit_id: u8, program: &Pubkey) -> Result<(), ProgramError> {
        if circuit_id as usize >= NUM_VERIFIERS {
            return Err(ProgramError::InvalidArgument);
        }
        let start = OFF_VERIFIERS + circuit_id as usize * 32;
        self.data[start..start + 32].copy_from_slice(program.as_ref());
        Ok(())
    }
    pub fn set_all_verifiers(&mut self, verifiers: &[Pubkey; NUM_VERIFIERS]) {
        for (i, v) in verifiers.iter().enumerate() {
            let start = OFF_VERIFIERS + i * 32;
            self.data[start..start + 32].copy_from_slice(v.as_ref());
        }
    }

    pub fn next_leaf_index(&self) -> u64 {
        u64::from_le_bytes(self.data[OFF_NEXT_LEAF_INDEX..OFF_NEXT_LEAF_INDEX + 8].try_into().unwrap())
    }
    pub fn set_next_leaf_index(&mut self, v: u64) {
        self.data[OFF_NEXT_LEAF_INDEX..OFF_NEXT_LEAF_INDEX + 8].copy_from_slice(&v.to_le_bytes());
    }

    pub fn side_node(&self, level: usize) -> [u8; 32] {
        let start = OFF_SIDE_NODES + level * 32;
        self.data[start..start + 32].try_into().unwrap()
    }
    pub fn set_side_node(&mut self, level: usize, v: &[u8; 32]) {
        let start = OFF_SIDE_NODES + level * 32;
        self.data[start..start + 32].copy_from_slice(v);
    }

    pub fn root_cursor(&self) -> u8 {
        self.data[OFF_ROOT_CURSOR]
    }
    pub fn set_root_cursor(&mut self, v: u8) {
        self.data[OFF_ROOT_CURSOR] = v;
    }

    pub fn root_at(&self, idx: u8) -> [u8; 32] {
        let start = OFF_ROOTS + idx as usize * 32;
        self.data[start..start + 32].try_into().unwrap()
    }
    pub fn set_root_at(&mut self, idx: u8, v: &[u8; 32]) {
        let start = OFF_ROOTS + idx as usize * 32;
        self.data[start..start + 32].copy_from_slice(v);
    }

    /// Push a new root into the 256-slot ring buffer, advancing the cursor.
    pub fn push_root(&mut self, root: &[u8; 32]) {
        let cur = self.root_cursor();
        self.set_root_at(cur, root);
        self.set_root_cursor(cur.wrapping_add(1));
    }

    /// True iff `root` is present anywhere in the ring buffer.
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        for i in 0..ROOT_RING {
            if self.root_at(i as u8) == *root {
                return true;
            }
        }
        false
    }
}

// ---- Asset --------------------------------------------------------------
// mint(32) vault(32) asset_id(20) bump(1)
pub const ASSET_SEED: &[u8] = b"asset";
pub const ASSET_LEN: usize = 32 + 32 + 20 + 1;
pub const ASSET_ID_LEN: usize = 20;

pub struct Asset<'a> {
    pub data: &'a mut [u8],
}

impl<'a> Asset<'a> {
    pub fn new(data: &'a mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != ASSET_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }
    pub fn mint(&self) -> Pubkey {
        Pubkey::try_from(&self.data[0..32]).unwrap()
    }
    pub fn vault(&self) -> Pubkey {
        Pubkey::try_from(&self.data[32..64]).unwrap()
    }
    pub fn asset_id(&self) -> [u8; ASSET_ID_LEN] {
        self.data[64..84].try_into().unwrap()
    }
    pub fn bump(&self) -> u8 {
        self.data[84]
    }
    pub fn write(&mut self, mint: &Pubkey, vault: &Pubkey, asset_id: &[u8; ASSET_ID_LEN], bump: u8) {
        self.data[0..32].copy_from_slice(mint.as_ref());
        self.data[32..64].copy_from_slice(vault.as_ref());
        self.data[64..84].copy_from_slice(asset_id);
        self.data[84] = bump;
    }
}

// ---- Nullifier ------------------------------------------------------------
// bump(1)
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
pub const NULLIFIER_LEN: usize = 1;
