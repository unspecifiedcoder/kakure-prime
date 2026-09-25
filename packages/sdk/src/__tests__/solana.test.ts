import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { assetId } from "../solana/assetId.js";
import { recipientField } from "../solana/recipientField.js";
import { poolPda, assetPda, nullifierPda } from "../solana/pda.js";
import { genesisLeaf } from "../solana/genesis.js";
import { genesisLeaf as genesisLeafDirect } from "../merkle/genesis.js";
import { CircuitId, PUBLIC_INPUT_COUNT, type ProofBundle } from "../tx/ports.js";
import { TxBuilder, KAKURE_COMPUTE_UNIT_LIMIT } from "../solana/txBuilder.js";
import { decodePool, isKnownRoot, rootIndexFor, POOL_LEN, type PoolAccount } from "../solana/poolAccounts.js";
import { decodePoolError } from "../solana/errors.js";
import { SolanaAccount, formatWalletAccountSeedMessage, encodeSolanaOffchainMessage } from "../keys/SolanaAccount.js";
import { ed25519 } from "@noble/curves/ed25519";

describe("solana/assetId (spec §3.2)", () => {
  it("is 20 bytes and deterministic for the same mint", () => {
    const mint = Keypair.generate().publicKey;
    const a = assetId(mint);
    const b = assetId(mint);
    expect(a.length).toBe(20);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("differs for different mints", () => {
    const a = assetId(Keypair.generate().publicKey);
    const b = assetId(Keypair.generate().publicKey);
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });
});

describe("solana/recipientField (spec §3.3)", () => {
  it("is 32 bytes with the top byte zeroed, so it is < the BN254 scalar modulus", () => {
    const dest = Keypair.generate().publicKey;
    const field = recipientField(dest);
    expect(field.length).toBe(32);
    expect(field[0]).toBe(0x00);
  });

  it("is deterministic and differs across destinations", () => {
    const d1 = Keypair.generate().publicKey;
    const d2 = Keypair.generate().publicKey;
    expect(Buffer.from(recipientField(d1)).toString("hex")).toBe(
      Buffer.from(recipientField(d1)).toString("hex"),
    );
    expect(Buffer.from(recipientField(d1)).toString("hex")).not.toBe(
      Buffer.from(recipientField(d2)).toString("hex"),
    );
  });
});

describe("solana/pda (I-2 seeds)", () => {
  const programId = Keypair.generate().publicKey;

  it("derives a stable Pool PDA off seed [b\"pool\"]", () => {
    const [a] = poolPda(programId);
    const [b] = poolPda(programId);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("derives an Asset PDA keyed by the 20-byte asset id", () => {
    const mint = Keypair.generate().publicKey;
    const [a] = assetPda(programId, assetId(mint));
    const [b] = assetPda(programId, assetId(mint));
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("rejects a malformed asset id length", () => {
    expect(() => assetPda(programId, new Uint8Array(19))).toThrow();
  });

  it("derives a Nullifier PDA keyed by the 32-byte nullifier", () => {
    const nf = new Uint8Array(32).fill(7);
    const [a] = nullifierPda(programId, nf);
    const [b] = nullifierPda(programId, nf);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("rejects a malformed nullifier length", () => {
    expect(() => nullifierPda(programId, new Uint8Array(31))).toThrow();
  });
});

describe("solana/genesis (spec §3.5: genesisLeaf(genesisHash) replaces genesisLeaf(chainId))", () => {
  it("re-exports the same function as merkle/genesis.js", async () => {
    const hash = 0xabcdefn;
    const a = await genesisLeaf(hash);
    const b = await genesisLeafDirect(hash);
    expect(a.toString()).toBe(b.toString());
  });

  it("is deterministic and differs across genesis hashes (cross-cluster replay defence)", async () => {
    const a = await genesisLeaf(1n);
    const b = await genesisLeaf(2n);
    expect(a.toString()).not.toBe(b.toString());
  });

  it("accepts a real 256-bit genesis hash at/above the BN254 field modulus without throwing", async () => {
    // A Solana cluster genesis hash (Connection.getGenesisHash(), decoded as a 32-byte big-endian
    // integer) is a uniformly random 256-bit value -- unlike the reference EVM implementation's original EVM chain id (a
    // small integer, always far below the ~254-bit BN254 modulus) -- so it is virtually always
    // >= the modulus. Before this fix, genesisLeaf's internal toFr(genesisHash) was strict and threw
    // "Value ... is greater or equal to field modulus" on essentially every real genesis hash.
    const aboveModulus = 0x394d7ef9377fad069fdf82199e1467e9eb8537362cb2e09d438950b8cf1cedb7n;
    await expect(genesisLeaf(aboveModulus)).resolves.toBeDefined();
    // Reducing the input mod the field ahead of the call must land on the exact same leaf --
    // confirms genesisLeaf reduces internally rather than silently truncating/misreducing.
    const FIELD_MODULUS =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const direct = await genesisLeaf(aboveModulus);
    const preReduced = await genesisLeaf(aboveModulus % FIELD_MODULUS);
    expect(direct.toString()).toBe(preReduced.toString());
  });
});

describe("solana/txBuilder (native kakure_pool wire format: borsh u8 tag + fields, processor.rs account order)", () => {
  const programId = Keypair.generate().publicKey;
  const builder = new TxBuilder(programId);

  function bundle(circuitId: CircuitId): ProofBundle {
    return {
      circuitId,
      // Workstream G: TxBuilder now expects the COMPRESSED 192-byte proof (see tx/ports.ts's
      // ProofBundle doc comment) -- 192 arbitrary bytes is fine for these wire-shape assertions,
      // which never decompress anything (that only happens on-chain).
      proof: new Uint8Array(192).fill(1),
      publicInputs: Array.from({ length: PUBLIC_INPUT_COUNT[circuitId] }, () =>
        new Uint8Array(32),
      ),
    };
  }

  /** A minimal `PoolAccount` fixture whose root ring is all-zero, matching `bundle()`'s all-zero
   *  public inputs (so the zero-filled "root" slot inside a spend bundle's public inputs resolves
   *  to SOME index in the ring -- `rootIndexFor` just needs byte equality, it does not care that
   *  the value happens to be zero here; only the on-chain `resolve_root` treats an actual zero
   *  ring SLOT as stale). */
  function poolFixture(): PoolAccount {
    return {
      authority: PublicKey.default,
      paused: false,
      complianceVersion: 0,
      compliancePkX: new Uint8Array(32),
      compliancePkY: new Uint8Array(32),
      verifiers: Array.from({ length: 7 }, () => PublicKey.default),
      nextLeafIndex: 0n,
      sideNodes: Array.from({ length: 32 }, () => new Uint8Array(32)),
      rootCursor: 1,
      roots: Array.from({ length: 256 }, () => new Uint8Array(32)),
    };
  }

  it("prepends a 1.4M CU ComputeBudget instruction to every built instruction set", () => {
    const mint = Keypair.generate().publicKey;
    const ixs = builder.deposit(bundle(CircuitId.Deposit), 1_000n, {
      pool: builder.poolAddress(),
      asset: PublicKey.default,
      mint,
      vault: PublicKey.default,
      depositorTokenAccount: PublicKey.default,
      depositor: Keypair.generate().publicKey,
      verifierProgram: PublicKey.default,
    });
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
    // 1_400_000 little-endian u32, per ComputeBudgetProgram.setComputeUnitLimit's own encoding.
    expect(KAKURE_COMPUTE_UNIT_LIMIT).toBe(1_400_000);
  });

  it("rejects a ProofBundle whose circuitId does not match the instruction being built", () => {
    expect(() =>
      builder.transfer(bundle(CircuitId.Deposit), {
        pool: builder.poolAddress(),
        nullifier: PublicKey.default,
        payer: Keypair.generate().publicKey,
        verifierProgram: PublicKey.default,
      }),
    ).toThrow();
  });

  it("rejects a public-input count that does not match I-1's frozen layout", () => {
    const bad = bundle(CircuitId.Transfer);
    (bad.publicInputs as Uint8Array[]).pop();
    expect(() =>
      builder.transfer(bad, {
        pool: builder.poolAddress(),
        nullifier: PublicKey.default,
        payer: Keypair.generate().publicKey,
        verifierProgram: PublicKey.default,
      }),
    ).toThrow();
  });

  it("initialize: tag 0, args in declaration order, genesis_leaf appended, authority+pool+program_data+system_program", async () => {
    const authority = Keypair.generate().publicKey;
    const programData = Keypair.generate().publicKey;
    const verifiers = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
    const compliancePkX = new Uint8Array(32).fill(0xaa);
    const compliancePkY = new Uint8Array(32).fill(0xbb);
    const genesisLeaf = new Uint8Array(32).fill(0xcc);

    const ixs = builder.initialize(
      { compliancePkX, compliancePkY, verifiers, genesisLeaf },
      { authority, programData },
    );
    expect(ixs).toHaveLength(2);
    const ix = ixs[1]!;

    // F9 fix: `initialize` now also takes the program's ProgramData account (read-only) so the
    // processor can check `authority == ProgramData.upgrade_authority_address`.
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0]).toMatchObject({ pubkey: authority, isSigner: true, isWritable: true });
    expect(ix.keys[1]).toMatchObject({
      pubkey: builder.poolAddress(),
      isSigner: false,
      isWritable: true,
    });
    expect(ix.keys[2]).toMatchObject({ pubkey: programData, isSigner: false, isWritable: false });
    expect(ix.keys[3]!.pubkey.toBase58()).toBe("11111111111111111111111111111111");

    // Wire format: u8(0) || compliance_pk_x[32] || compliance_pk_y[32] || verifiers[7*32] || genesis_leaf[32].
    const data = Buffer.from(ix.data);
    expect(data[0]).toBe(0);
    expect(data.subarray(1, 33)).toEqual(Buffer.from(compliancePkX));
    expect(data.subarray(33, 65)).toEqual(Buffer.from(compliancePkY));
    for (let i = 0; i < 7; i++) {
      expect(data.subarray(65 + i * 32, 65 + (i + 1) * 32)).toEqual(Buffer.from(verifiers[i]!.toBytes()));
    }
    expect(data.subarray(65 + 7 * 32, 65 + 7 * 32 + 32)).toEqual(Buffer.from(genesisLeaf));
    expect(data.length).toBe(1 + 32 + 32 + 7 * 32 + 32);
  });

  it("setVerifier: tag 1, circuit_id(u8) + program(32), authority(signer,r) then pool(w)", () => {
    const authority = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const verifierProgram = Keypair.generate().publicKey;
    const ix = builder.setVerifier(CircuitId.Withdraw, verifierProgram, { pool, authority });

    expect(ix.keys).toEqual([
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
    ]);
    const data = Buffer.from(ix.data);
    expect(data[0]).toBe(1);
    expect(data[1]).toBe(CircuitId.Withdraw);
    expect(data.subarray(2, 34)).toEqual(Buffer.from(verifierProgram.toBytes()));
    expect(data.length).toBe(1 + 1 + 32);
  });

  it("rotateComplianceKey: tag 2, x[32] || y[32]", () => {
    const authority = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const x = new Uint8Array(32).fill(1);
    const y = new Uint8Array(32).fill(2);
    const ix = builder.rotateComplianceKey(x, y, { pool, authority });
    const data = Buffer.from(ix.data);
    expect(data[0]).toBe(2);
    expect(data.subarray(1, 33)).toEqual(Buffer.from(x));
    expect(data.subarray(33, 65)).toEqual(Buffer.from(y));
  });

  it("setPaused: tag 3, bool as a single 0/1 byte", () => {
    const authority = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const ixTrue = builder.setPaused(true, { pool, authority });
    const ixFalse = builder.setPaused(false, { pool, authority });
    expect(Buffer.from(ixTrue.data)).toEqual(Buffer.from([3, 1]));
    expect(Buffer.from(ixFalse.data)).toEqual(Buffer.from([3, 0]));
  });

  it("deposit: tag 4, defaults token_program/associated_token_program to the well-known ids, exact account order", () => {
    const mint = Keypair.generate().publicKey;
    const depositor = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const asset = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const depositorTokenAccount = Keypair.generate().publicKey;
    const verifierProgram = Keypair.generate().publicKey;

    const ixs = builder.deposit(bundle(CircuitId.Deposit), 1_000n, {
      pool,
      asset,
      mint,
      vault,
      depositorTokenAccount,
      depositor,
      verifierProgram,
    });
    const ix = ixs[1]!;
    const pubkeys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(pubkeys).toEqual([
      depositor.toBase58(),
      pool.toBase58(),
      asset.toBase58(),
      mint.toBase58(),
      vault.toBase58(),
      depositorTokenAccount.toBase58(),
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "11111111111111111111111111111111",
      verifierProgram.toBase58(),
    ]);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true }); // depositor
    const data = Buffer.from(ix.data);
    expect(data[0]).toBe(4);
  });

  it("transfer/transfer_multisig/split_multisig: payer, pool, nullifier, system_program, verifier (tags 5/6/7)", () => {
    const payer = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const nullifier = Keypair.generate().publicKey;
    const verifierProgram = Keypair.generate().publicKey;
    const accounts = { pool, nullifier, payer, verifierProgram };

    const pf = poolFixture();
    const cases: Array<[CircuitId, (b: ProofBundle) => TransactionInstruction[], number]> = [
      [CircuitId.Transfer, (b) => builder.transfer(b, accounts, pf), 5],
      [CircuitId.TransferMultisig, (b) => builder.transferMultisig(b, accounts, pf), 6],
      [CircuitId.SplitMultisig, (b) => builder.splitMultisig(b, accounts, pf), 7],
    ];
    for (const [circuitId, build, tag] of cases) {
      const ix = build(bundle(circuitId))[1]!;
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
        payer.toBase58(),
        pool.toBase58(),
        nullifier.toBase58(),
        "11111111111111111111111111111111",
        verifierProgram.toBase58(),
      ]);
      expect(ix.data[0]).toBe(tag);
    }
  });

  it("workstream G wire format: transfer writes a fixed 192-byte proof, 21 (not 24) stripped public inputs, and a resolved root_index byte", () => {
    const payer = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const nullifier = Keypair.generate().publicKey;
    const verifierProgram = Keypair.generate().publicKey;

    const b = bundle(CircuitId.Transfer);
    const compressedProof = new Uint8Array(192).fill(0x42);
    (b as { proof: Uint8Array }).proof = compressedProof;
    const nullifierField = new Uint8Array(32).fill(0x11);
    const root = new Uint8Array(32).fill(0x77);
    // I-1 order: [cpk_x, cpk_y, nullifier, root, memo_leaf, ..., change_ct6].
    (b.publicInputs as Uint8Array[])[0] = new Uint8Array(32).fill(0xaa); // cpk_x (stripped)
    (b.publicInputs as Uint8Array[])[1] = new Uint8Array(32).fill(0xbb); // cpk_y (stripped)
    (b.publicInputs as Uint8Array[])[2] = nullifierField;
    (b.publicInputs as Uint8Array[])[3] = root; // root (stripped, resolved to root_index)

    const pf = poolFixture();
    // Put `root` at a specific, non-default ring slot so root_index isn't just the fixture's
    // default cursor-1 by coincidence.
    const rootIndex = 200;
    (pf.roots as Uint8Array[])[rootIndex] = root;
    pf.rootCursor = (rootIndex + 1) % 256;
    expect(rootIndexFor(pf, root)).toBe(rootIndex);

    const ix = builder.transfer(b, { pool, nullifier, payer, verifierProgram }, pf)[1]!;
    const data = Buffer.from(ix.data);
    let off = 0;
    expect(data[off]).toBe(5); // tag
    off += 1;
    expect(data.subarray(off, off + 192)).toEqual(Buffer.from(compressedProof)); // proof: [u8;192], no length prefix
    off += 192;
    expect(data.readUInt32LE(off)).toBe(21); // Vec<[u8;32]> length prefix -- 21, not the full 24
    off += 4;
    expect(data.subarray(off, off + 32)).toEqual(Buffer.from(nullifierField)); // wire index 0 == nullifier
    off += 21 * 32;
    expect(data.length).toBe(off + 1); // exactly one trailing byte: root_index
    expect(data[off]).toBe(rootIndex);
  });

  it("transfer throws RootNotInRingError when the bundle's root is nowhere in the pool's ring", () => {
    const b = bundle(CircuitId.Transfer);
    (b.publicInputs as Uint8Array[])[3] = new Uint8Array(32).fill(0x99); // a root not in poolFixture()'s all-zero ring
    const pf = poolFixture();
    expect(() =>
      builder.transfer(
        b,
        {
          pool: builder.poolAddress(),
          nullifier: Keypair.generate().publicKey,
          payer: Keypair.generate().publicKey,
          verifierProgram: Keypair.generate().publicKey,
        },
        pf,
      ),
    ).toThrow(/root/i);
  });

  it("joinMultisig: tag 8, payer, pool, nullifier_a, nullifier_b, system_program, verifier", () => {
    const payer = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const nullifierA = Keypair.generate().publicKey;
    const nullifierB = Keypair.generate().publicKey;
    const verifierProgram = Keypair.generate().publicKey;
    const ix = builder.joinMultisig(
      bundle(CircuitId.JoinMultisig),
      { pool, nullifierA, nullifierB, payer, verifierProgram },
      poolFixture(),
    )[1]!;
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      payer.toBase58(),
      pool.toBase58(),
      nullifierA.toBase58(),
      nullifierB.toBase58(),
      "11111111111111111111111111111111",
      verifierProgram.toBase58(),
    ]);
    expect(ix.data[0]).toBe(8);
  });

  it("withdraw/withdraw_multisig: tags 9/10, payer, pool, nullifier, asset, mint, vault, destination, token_program, system_program, verifier", () => {
    const payer = Keypair.generate().publicKey;
    const pool = builder.poolAddress();
    const asset = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const nullifier = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const destinationTokenAccount = Keypair.generate().publicKey;
    const verifierProgram = Keypair.generate().publicKey;
    const accounts = { pool, asset, mint, nullifier, vault, destinationTokenAccount, payer, verifierProgram };

    const pf = poolFixture();
    const wIx = builder.withdraw(bundle(CircuitId.Withdraw), 500n, accounts, pf)[1]!;
    const wmIx = builder.withdrawMultisig(bundle(CircuitId.WithdrawMultisig), 500n, accounts, pf)[1]!;
    for (const [ix, tag] of [[wIx, 9], [wmIx, 10]] as const) {
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
        payer.toBase58(),
        pool.toBase58(),
        nullifier.toBase58(),
        asset.toBase58(),
        mint.toBase58(),
        vault.toBase58(),
        destinationTokenAccount.toBase58(),
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "11111111111111111111111111111111",
        verifierProgram.toBase58(),
      ]);
      expect(ix.data[0]).toBe(tag);
    }
    // Workstream G: root_index (u8) is now PoolInstruction::Withdraw's LAST field (declared after
    // amount), so amount(u64 LE) is the second-to-last 8 bytes, with a single trailing root_index
    // byte after it -- not the very last 8 bytes anymore.
    const data = Buffer.from(wIx.data);
    expect(data.readBigUInt64LE(data.length - 9)).toBe(500n);
    expect(data.length - 1).toBeGreaterThanOrEqual(0); // sanity: root_index byte exists
  });
});

describe("solana/poolAccounts (decodePool, I-2 zero-copy Pool layout)", () => {
  function buildPoolBytes(overrides?: Partial<{
    authority: PublicKey;
    paused: boolean;
    complianceVersion: number;
    compliancePkX: Uint8Array;
    compliancePkY: Uint8Array;
    verifiers: PublicKey[];
    nextLeafIndex: bigint;
    rootCursor: number;
    rootAt5: Uint8Array;
  }>): Buffer {
    const buf = Buffer.alloc(POOL_LEN);
    const authority = overrides?.authority ?? Keypair.generate().publicKey;
    authority.toBuffer().copy(buf, 0);
    buf[32] = overrides?.paused ? 1 : 0;
    buf.writeUInt32LE(overrides?.complianceVersion ?? 0, 33);
    (overrides?.compliancePkX ?? new Uint8Array(32).fill(0x11)).forEach((b, i) => (buf[37 + i] = b));
    (overrides?.compliancePkY ?? new Uint8Array(32).fill(0x22)).forEach((b, i) => (buf[69 + i] = b));
    const verifiers = overrides?.verifiers ?? Array.from({ length: 7 }, () => Keypair.generate().publicKey);
    verifiers.forEach((v, i) => v.toBuffer().copy(buf, 101 + i * 32));
    buf.writeBigUInt64LE(overrides?.nextLeafIndex ?? 3n, 325);
    // side_nodes: 333..1357, left zeroed.
    buf[1357] = overrides?.rootCursor ?? 1;
    if (overrides?.rootAt5) overrides.rootAt5.forEach((b, i) => (buf[1358 + 5 * 32 + i] = b));
    return buf;
  }

  it("decodes every field at the exact offsets from state.rs", () => {
    const authority = Keypair.generate().publicKey;
    const verifiers = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
    const compliancePkX = new Uint8Array(32).fill(0xaa);
    const compliancePkY = new Uint8Array(32).fill(0xbb);
    const bytes = buildPoolBytes({
      authority,
      paused: true,
      complianceVersion: 4,
      compliancePkX,
      compliancePkY,
      verifiers,
      nextLeafIndex: 12345n,
      rootCursor: 7,
    });

    const pool = decodePool(bytes);
    expect(pool.authority.equals(authority)).toBe(true);
    expect(pool.paused).toBe(true);
    expect(pool.complianceVersion).toBe(4);
    expect(Buffer.from(pool.compliancePkX)).toEqual(Buffer.from(compliancePkX));
    expect(Buffer.from(pool.compliancePkY)).toEqual(Buffer.from(compliancePkY));
    expect(pool.verifiers.map((v) => v.toBase58())).toEqual(verifiers.map((v) => v.toBase58()));
    expect(pool.nextLeafIndex).toBe(12345n);
    expect(pool.rootCursor).toBe(7);
    expect(pool.sideNodes).toHaveLength(32);
    expect(pool.roots).toHaveLength(256);
  });

  it("rejects data whose length is not exactly POOL_LEN (9550 bytes)", () => {
    expect(() => decodePool(new Uint8Array(100))).toThrow();
    expect(() => decodePool(new Uint8Array(POOL_LEN + 1))).toThrow();
  });

  it("isKnownRoot finds a root anywhere in the 256-entry ring, and rejects a malformed root length", () => {
    const rootAt5 = new Uint8Array(32).fill(0x42);
    const pool = decodePool(buildPoolBytes({ rootAt5 }));
    expect(isKnownRoot(pool, rootAt5)).toBe(true);
    expect(isKnownRoot(pool, new Uint8Array(32).fill(0x43))).toBe(false);
    expect(() => isKnownRoot(pool, new Uint8Array(31))).toThrow();
  });
});

describe("solana/errors (decodePoolError, error.rs PoolError -> ProgramError::Custom(n))", () => {
  it("maps every PoolError index by declaration order", () => {
    expect(decodePoolError(0)).toBe("Paused");
    expect(decodePoolError(5)).toBe("InvalidProof");
    expect(decodePoolError(13)).toBe("VerifierUnset");
  });

  it("returns undefined for an out-of-range code (not a PoolError -- e.g. a CPI'd program's own error)", () => {
    expect(decodePoolError(14)).toBeUndefined();
    expect(decodePoolError(9999)).toBeUndefined();
  });

  it("extracts the code from a {InstructionError: [index, {Custom: n}]} shape", () => {
    expect(decodePoolError({ InstructionError: [0, { Custom: 3 }] })).toBe("StaleRoot");
  });

  it("extracts the code from an Error message in the standard RPC 'custom program error: 0x..' form", () => {
    const err = new Error(
      "failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x5",
    );
    expect(decodePoolError(err)).toBe("InvalidProof");
  });

  it("returns undefined when nothing resembling a custom code is present", () => {
    expect(decodePoolError(new Error("network timeout"))).toBeUndefined();
    expect(decodePoolError(undefined)).toBeUndefined();
  });

  // slice-2 F-6: a verifier CPI's own error (a Custom(n) or InvalidInstructionData surfaced by a
  // FAILED invoke()) must never be misattributed to an unrelated PoolError just because the raw
  // numeric code happens to also be a valid PoolError index.
  const POOL_ID = "Poo1111111111111111111111111111111111111";
  const VERIFIER_ID = "Ver1111111111111111111111111111111111111";

  it("does not report a verifier's Custom(9) as the pool's AssetCollision", () => {
    const err = { InstructionError: [1, { Custom: 9 }] };
    const logs = [
      `Program ${POOL_ID} invoke [1]`,
      `Program ${VERIFIER_ID} invoke [2]`,
      "Program log: Gnark error: PublicInputGreaterThanFieldSize",
      `Program ${VERIFIER_ID} failed: custom program error: 0x9`,
      `Program ${POOL_ID} failed: ...`,
    ];
    expect(decodePoolError(err, logs)).toBe("VerifierError(PublicInputGreaterThanFieldSize)");
    expect(
      decodePoolError(
        { InstructionError: [1, "InvalidInstructionData"] },
        logs.slice(0, 2).concat(`Program ${VERIFIER_ID} failed: invalid instruction data`),
      ),
    ).toBe("InvalidProof");
  });

  it("still maps the pool's own Custom(n) when the failure did not happen inside a CPI", () => {
    const logs = [`Program ${POOL_ID} invoke [1]`, `Program ${POOL_ID} failed: custom program error: 0x3`];
    expect(decodePoolError({ InstructionError: [0, { Custom: 3 }] }, logs)).toBe("StaleRoot");
  });
});

describe("keys/SolanaAccount (master plan C.4: ed25519-signature-seeded root secret)", () => {
  it("is deterministic for the same keypair", async () => {
    const kp = Keypair.generate();
    const a = await SolanaAccount.fromKeypair(kp);
    const b = await SolanaAccount.fromKeypair(kp);
    expect((await a.getViewKey()).toString()).toBe((await b.getViewKey()).toString());
  });

  it("differs across keypairs", async () => {
    const a = await SolanaAccount.fromKeypair(Keypair.generate());
    const b = await SolanaAccount.fromKeypair(Keypair.generate());
    expect((await a.getViewKey()).toString()).not.toBe((await b.getViewKey()).toString());
  });

  // slice-2 F-7: fromWalletSigner derives the same KIND of root secret as fromKeypair, but from a
  // signature over a formatted, warning-carrying, wallet-address-bound message (the Solana
  // off-chain-message envelope) rather than an opaque fixed string -- so it must agree between a
  // "real" ed25519 signer and any wallet-standard-shaped `signMessage` mock that signs the exact
  // same formatted bytes, and it must refuse a signer whose signature is not deterministic.
  describe("fromWalletSigner (wallet-adapter signMessage, off-chain-message envelope)", () => {
    it("agrees with a mocked wallet-standard signMessage over the same formatted bytes", async () => {
      const kp = Keypair.generate();
      const seed = kp.secretKey.slice(0, 32);
      const walletBase58 = kp.publicKey.toBase58();

      // Two independently-constructed "wallet-standard" signMessage mocks, both correctly signing
      // the exact bytes `fromWalletSigner` asks them to sign -- must derive the identical account.
      const mockSignMessage = async (message: Uint8Array) => ed25519.sign(message, seed);

      const a = await SolanaAccount.fromWalletSigner(mockSignMessage, walletBase58);
      const b = await SolanaAccount.fromWalletSigner(mockSignMessage, walletBase58);
      expect((await a.getViewKey()).toString()).toBe((await b.getViewKey()).toString());

      // And it must differ from fromKeypair's account (different message signed -> different key).
      const viaKeypair = await SolanaAccount.fromKeypair(kp);
      expect((await viaKeypair.getViewKey()).toString()).not.toBe((await a.getViewKey()).toString());
    });

    it("a substituted wallet address changes the derived key", async () => {
      const kp = Keypair.generate();
      const seed = kp.secretKey.slice(0, 32);
      const mockSignMessage = async (message: Uint8Array) => ed25519.sign(message, seed);

      const real = await SolanaAccount.fromWalletSigner(mockSignMessage, kp.publicKey.toBase58());
      const substituted = await SolanaAccount.fromWalletSigner(
        mockSignMessage,
        Keypair.generate().publicKey.toBase58(),
      );
      expect((await real.getViewKey()).toString()).not.toBe((await substituted.getViewKey()).toString());
    });

    it("refuses a non-deterministic signer", async () => {
      let call = 0;
      const flakySignMessage = async (message: Uint8Array) => {
        call += 1;
        // First call signs correctly; second call returns garbage -- simulates a signer whose
        // output is not a pure function of the message (e.g. includes fresh randomness).
        if (call === 1) return ed25519.sign(message, Keypair.generate().secretKey.slice(0, 32));
        return new Uint8Array(64).fill(0xff);
      };
      await expect(
        SolanaAccount.fromWalletSigner(flakySignMessage, Keypair.generate().publicKey.toBase58()),
      ).rejects.toThrow(/not deterministic/);
    });

    it("formatWalletAccountSeedMessage wraps the warning text in the Solana off-chain-message envelope", () => {
      const walletBase58 = Keypair.generate().publicKey.toBase58();
      const encoded = formatWalletAccountSeedMessage(walletBase58, "app.example");
      // 0xff || "solana offchain" (16 bytes) || version(1) || format(1) || len(2 LE) || text
      expect(encoded[0]).toBe(0xff);
      expect(new TextDecoder().decode(encoded.slice(1, 16))).toBe("solana offchain");
      const text = new TextDecoder().decode(encoded.slice(20));
      expect(text).toContain("kakure.account.v1");
      expect(text).toContain("Only sign on app.example");
      expect(text).toContain(`Wallet: ${walletBase58}`);
      // Round-trips through the raw envelope encoder too.
      expect(encoded).toEqual(encodeSolanaOffchainMessage(new TextEncoder().encode(text)));
    });
  });
});

describe("keys/SolanaAccount.fromAccountSignature (ws-I: browser wallet-adapter signMessage path)", () => {
  it("matches fromKeypair for the same keypair's deterministic ACCOUNT_SEED_MESSAGE signature", async () => {
    const kp = Keypair.generate();
    const seed = kp.secretKey.slice(0, 32);
    const { ed25519 } = await import("@noble/curves/ed25519");
    const { ACCOUNT_SEED_MESSAGE } = await import("../keys/SolanaAccount.js");
    const signature = ed25519.sign(ACCOUNT_SEED_MESSAGE, seed);

    const viaSignature = await SolanaAccount.fromAccountSignature(signature);
    const viaKeypair = await SolanaAccount.fromKeypair(kp);
    expect((await viaSignature.getViewKey()).toString()).toBe(
      (await viaKeypair.getViewKey()).toString(),
    );
  });

  it("is deterministic for the same signature bytes", async () => {
    const sig = new Uint8Array(64).fill(0x5a);
    const a = await SolanaAccount.fromAccountSignature(sig);
    const b = await SolanaAccount.fromAccountSignature(sig);
    expect((await a.getViewKey()).toString()).toBe((await b.getViewKey()).toString());
  });

  it("differs across signatures", async () => {
    const a = await SolanaAccount.fromAccountSignature(new Uint8Array(64).fill(1));
    const b = await SolanaAccount.fromAccountSignature(new Uint8Array(64).fill(2));
    expect((await a.getViewKey()).toString()).not.toBe((await b.getViewKey()).toString());
  });
});
