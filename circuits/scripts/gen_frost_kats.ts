#!/usr/bin/env -S npx tsx
// Regenerates the FROST-multisig KAT fixtures (join/split/transfer/withdraw) for the kakure.*
// domain rename. Generalizes the gen-*-multisig-kat.test.ts pattern in packages/sdk/src/__tests__
// into one script: it reproduces each test's exact witness construction with the *current*
// (already-renamed) domain constants and prints every value that needs to land in both the TS
// test file's expect(...) fixtures and the corresponding circuits/multisig/*/src/main.nr KAT
// globals + Prover.toml.
//
// Run from anywhere: `npx tsx circuits/scripts/gen_frost_kats.ts`. Node ESM resolves each
// module's bare imports relative to ITS OWN file location (not process.cwd()), so this script's
// own top-level `@aztec/foundation`/`@zk-kit/baby-jubjub` imports are resolved via `createRequire`
// against packages/sdk's node_modules below; the relative imports of sdk source files resolve
// normally (those files' own bare imports resolve against packages/sdk/node_modules on their own).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/sdk/package.json", import.meta.url));
const { Fr } = require("@aztec/foundation/fields");
const { Base8, mulPointEscalar } = require("@zk-kit/baby-jubjub");
import { scalarBaseMul, polyEval, SUBORDER } from "../../packages/sdk/src/tss/index.js";
import {
  bjjCiphersuite as cs,
  encodeMessage,
  commit,
  groupCommitment,
  bindingFactors,
  signShare,
  aggregate,
  verify,
  multisigOwner,
  msgJoin,
  msgSplit,
  msgTransfer,
  msgWithdraw,
} from "../../packages/sdk/src/frost/index.js";
import { leaf, Note } from "../../packages/sdk/src/note/note.js";
import { computePsi, computeNullifier } from "../../packages/sdk/src/note/nullifier.js";
import { isEvenY } from "../../packages/sdk/src/note/keys.js";
import { deriveCek } from "../../packages/sdk/src/crypto/kem.js";
import { Poseidon } from "../../packages/sdk/src/crypto/Poseidon.js";
import type { Point } from "../../packages/sdk/src/tss/index.js";

const ASSET_ID = 0x1234567890123456789012345678901234567890n;
const COMPLIANCE_PK: Point = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];
const OLD_PSI =
  0x0981a88f9e119b057498a4ab99ed5379a1ea91c642454fc0c07aacc1f5cd5731n;

const hex = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

function evenYEphsFrom(start: bigint, n: number): bigint[] {
  const out: bigint[] = [];
  let s = start;
  while (out.length < n) {
    if (isEvenY(mulPointEscalar(Base8, s))) out.push(s);
    s++;
  }
  return out;
}

async function sharedGroup() {
  const c = 12345678901234567890123456789012345678901234567890n % SUBORDER;
  const coeffs = [
    c,
    98765432109876543210987654321098765432109876543210n % SUBORDER,
    55555555555555555555555555555555555555555555555555n % SUBORDER,
  ];
  const gpk = scalarBaseMul(c);
  const ids = [1n, 2n, 3n];
  const shares = new Map(ids.map((i) => [i, polyEval(coeffs, i)]));
  const owner = new Fr(await multisigOwner(gpk));
  return { gpk, ids, shares, owner };
}

async function signOverMessage(
  gpk: Point,
  ids: bigint[],
  shares: Map<bigint, bigint>,
  m: bigint,
) {
  const msg = encodeMessage(m);
  const rounds = new Map<bigint, { nonces: any; commitment: any }>();
  for (const i of ids) {
    const h = new Uint8Array(32).fill(Number(i) * 2 + 40);
    const b = new Uint8Array(32).fill(Number(i) * 2 + 41);
    rounds.set(i, await commit(cs, i, shares.get(i)!, h, b));
  }
  const commitments = ids.map((i) => rounds.get(i)!.commitment);
  const zs: bigint[] = [];
  for (const i of ids) {
    zs.push(
      await signShare(cs, i, rounds.get(i)!.nonces, shares.get(i)!, gpk, msg, commitments),
    );
  }
  const R = groupCommitment(cs, commitments, await bindingFactors(cs, gpk, msg, commitments));
  const sig = aggregate(cs, R, zs);
  if (!(await verify(cs, gpk, msg, sig))) {
    throw new Error("FROST signature failed to verify");
  }
  return sig;
}

async function genJoin() {
  const { gpk, ids, shares, owner } = await sharedGroup();
  const A_VALUE = 100n;
  const B_VALUE = 50n;
  const OUT_VALUE = 150n;
  const A_PSI = 0x01n;
  const B_PSI = 0x02n;
  const OUT_PARENTS = 0x100000000n;

  const msNote = (value: bigint, psi: Fr, noteType: bigint, parents: bigint): Note => ({
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(noteType),
    conditionsHash: new Fr(0n),
    value,
    owner,
    psi,
    parents: new Fr(parents),
  });

  const noteA = msNote(A_VALUE, new Fr(A_PSI), 1n, 0n);
  const noteB = msNote(B_VALUE, new Fr(B_PSI), 1n, 0n);
  const leafA = await leaf(noteA);
  const leafB = await leaf(noteB);
  const root = await Poseidon.hash([leafA, leafB]);
  const nullifierA = await computeNullifier(new Fr(A_PSI), new Fr(0n));
  const nullifierB = await computeNullifier(new Fr(B_PSI), new Fr(1n));

  const [ephOut] = evenYEphsFrom(1n, 1);
  const psiOut = await computePsi(deriveCek(new Fr(ephOut), COMPLIANCE_PK));
  const outNote = msNote(OUT_VALUE, psiOut, 1n, OUT_PARENTS);
  const outLeaf = await leaf(outNote);

  const m = await msgJoin({
    root: root.toBigInt(),
    nullifierA: nullifierA.toBigInt(),
    nullifierB: nullifierB.toBigInt(),
    outLeaf: outLeaf.toBigInt(),
    asset: ASSET_ID,
  });
  const sig = await signOverMessage(gpk, ids, shares, m);

  console.log("\n=== join_multisig ===");
  console.log("gpk[0]", hex(gpk[0]), "gpk[1]", hex(gpk[1]));
  console.log("owner", hex(owner.toBigInt()));
  console.log("ephOut", ephOut);
  console.log("psiOut", hex(psiOut.toBigInt()));
  console.log("leafA", hex(leafA.toBigInt()));
  console.log("leafB", hex(leafB.toBigInt()));
  console.log("root", hex(root.toBigInt()));
  console.log("nullifierA", hex(nullifierA.toBigInt()));
  console.log("nullifierB", hex(nullifierB.toBigInt()));
  console.log("outLeaf", hex(outLeaf.toBigInt()));
  console.log("sig.R[0]", hex(sig.R[0]), "sig.R[1]", hex(sig.R[1]));
  console.log("sig.z", hex(sig.z));
  console.log("m", hex(m));
}

async function genSplit() {
  const { gpk, ids, shares, owner } = await sharedGroup();
  const OLD_VALUE = 100n;
  const OUT1_VALUE = 60n;
  const OUT2_VALUE = 40n;

  const msNote = (value: bigint, psi: Fr, noteType: bigint): Note => ({
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(noteType),
    conditionsHash: new Fr(0n),
    value,
    owner,
    psi,
    parents: new Fr(0n),
  });

  const oldNote = msNote(OLD_VALUE, new Fr(OLD_PSI), 1n);
  const root = await leaf(oldNote);
  const nullifier = await computeNullifier(new Fr(OLD_PSI), new Fr(0n));

  const [eph1, eph2] = evenYEphsFrom(1n, 2);
  const psi1 = await computePsi(deriveCek(new Fr(eph1), COMPLIANCE_PK));
  const psi2 = await computePsi(deriveCek(new Fr(eph2), COMPLIANCE_PK));
  const out1Leaf = await leaf(msNote(OUT1_VALUE, psi1, 1n));
  const out2Leaf = await leaf(msNote(OUT2_VALUE, psi2, 1n));

  const m = await msgSplit({
    root: root.toBigInt(),
    nullifier: nullifier.toBigInt(),
    out1Leaf: out1Leaf.toBigInt(),
    out2Leaf: out2Leaf.toBigInt(),
    asset: ASSET_ID,
  });
  const sig = await signOverMessage(gpk, ids, shares, m);

  console.log("\n=== split_multisig ===");
  console.log("gpk[0]", hex(gpk[0]), "gpk[1]", hex(gpk[1]));
  console.log("owner", hex(owner.toBigInt()));
  console.log("eph1", eph1, "eph2", eph2);
  console.log("psi1", hex(psi1.toBigInt()));
  console.log("psi2", hex(psi2.toBigInt()));
  console.log("root", hex(root.toBigInt()));
  console.log("nullifier", hex(nullifier.toBigInt()));
  console.log("out1Leaf", hex(out1Leaf.toBigInt()));
  console.log("out2Leaf", hex(out2Leaf.toBigInt()));
  console.log("sig.R[0]", hex(sig.R[0]), "sig.R[1]", hex(sig.R[1]));
  console.log("sig.z", hex(sig.z));
  console.log("m", hex(m));
}

async function genTransfer() {
  const { gpk, ids, shares, owner } = await sharedGroup();
  const OLD_VALUE = 100n;
  const MEMO_VALUE = 40n;
  const CHANGE_VALUE = 60n;
  const RECIPIENT_IN_PUB: Point = [
    0x1b16e357953d68d73398c838aa883cc65ddae2aef75a4bc437e4232afdbe43c8n,
    0x02d7ee0be055310d2895c5ed5090a8aa1c700e73c64294f1e817ec77f46b4fdcn,
  ];
  const PARENTS_HIDDEN =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n - 1n;

  const oldNote: Note = {
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(1n),
    conditionsHash: new Fr(0n),
    value: OLD_VALUE,
    owner,
    psi: new Fr(OLD_PSI),
    parents: new Fr(0n),
  };
  const root = await leaf(oldNote);
  const nullifier = await computeNullifier(new Fr(OLD_PSI), new Fr(0n));

  const [memoEph, changeEph] = evenYEphsFrom(1n, 2);
  const memoPsi = await computePsi(deriveCek(new Fr(memoEph), COMPLIANCE_PK));
  const changePsi = await computePsi(deriveCek(new Fr(changeEph), COMPLIANCE_PK));
  const memoOwner = new Fr(await multisigOwner(RECIPIENT_IN_PUB));

  const memoNote: Note = {
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(0n),
    conditionsHash: new Fr(0n),
    value: MEMO_VALUE,
    owner: memoOwner,
    psi: memoPsi,
    parents: new Fr(PARENTS_HIDDEN),
  };
  const changeNote: Note = {
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(1n),
    conditionsHash: new Fr(0n),
    value: CHANGE_VALUE,
    owner,
    psi: changePsi,
    parents: new Fr(0n),
  };
  const memoLeaf = await leaf(memoNote);
  const changeLeaf = await leaf(changeNote);

  const m = await msgTransfer({
    root: root.toBigInt(),
    nullifier: nullifier.toBigInt(),
    memoLeaf: memoLeaf.toBigInt(),
    memoTag: RECIPIENT_IN_PUB[0],
    changeLeaf: changeLeaf.toBigInt(),
    asset: ASSET_ID,
  });
  const sig = await signOverMessage(gpk, ids, shares, m);

  console.log("\n=== transfer_multisig ===");
  console.log("gpk[0]", hex(gpk[0]), "gpk[1]", hex(gpk[1]));
  console.log("memoEph", memoEph, "changeEph", changeEph);
  console.log("memoOwner", hex(memoOwner.toBigInt()));
  console.log("memoPsi", hex(memoPsi.toBigInt()));
  console.log("changePsi", hex(changePsi.toBigInt()));
  console.log("root", hex(root.toBigInt()));
  console.log("nullifier", hex(nullifier.toBigInt()));
  console.log("memoLeaf", hex(memoLeaf.toBigInt()));
  console.log("changeLeaf", hex(changeLeaf.toBigInt()));
  console.log("sig.R[0]", hex(sig.R[0]), "sig.R[1]", hex(sig.R[1]));
  console.log("sig.z", hex(sig.z));
  console.log("m", hex(m));
}

async function genWithdraw() {
  const { gpk, ids, shares, owner } = await sharedGroup();
  const OLD_VALUE = 1000n;
  const WITHDRAW_VALUE = 300n;
  const CHANGE_VALUE = OLD_VALUE - WITHDRAW_VALUE;
  const RECIPIENT = 0x00c0ffee00c0ffee00c0ffee00c0ffee00c0ffeen;
  const INTENT_HASH = 0n;

  const oldNote: Note = {
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(1n),
    conditionsHash: new Fr(0n),
    value: OLD_VALUE,
    owner,
    psi: new Fr(OLD_PSI),
    parents: new Fr(0n),
  };
  const root = await leaf(oldNote);
  const nullifier = await computeNullifier(new Fr(OLD_PSI), new Fr(0n));

  const [changeEph] = evenYEphsFrom(1n, 1);
  const changePsi = await computePsi(deriveCek(new Fr(changeEph), COMPLIANCE_PK));
  const changeNote: Note = {
    noteVersion: new Fr(1n),
    assetId: new Fr(ASSET_ID),
    noteType: new Fr(1n),
    conditionsHash: new Fr(0n),
    value: CHANGE_VALUE,
    owner,
    psi: changePsi,
    parents: new Fr(0n),
  };
  const changeLeaf = await leaf(changeNote);

  const m = await msgWithdraw({
    root: root.toBigInt(),
    nullifier: nullifier.toBigInt(),
    changeLeaf: changeLeaf.toBigInt(),
    publicOut: WITHDRAW_VALUE,
    asset: ASSET_ID,
    recipient: RECIPIENT,
    intentHash: INTENT_HASH,
  });
  const sig = await signOverMessage(gpk, ids, shares, m);

  console.log("\n=== withdraw_multisig ===");
  console.log("gpk[0]", hex(gpk[0]), "gpk[1]", hex(gpk[1]));
  console.log("owner", hex(owner.toBigInt()));
  console.log("changeEph", changeEph);
  console.log("changePsi", hex(changePsi.toBigInt()));
  console.log("root", hex(root.toBigInt()));
  console.log("nullifier", hex(nullifier.toBigInt()));
  console.log("changeLeaf", hex(changeLeaf.toBigInt()));
  console.log("sig.R[0]", hex(sig.R[0]), "sig.R[1]", hex(sig.R[1]));
  console.log("sig.z", hex(sig.z));
  console.log("m", hex(m));
}

async function main() {
  await genJoin();
  await genSplit();
  await genTransfer();
  await genWithdraw();
}

main();
