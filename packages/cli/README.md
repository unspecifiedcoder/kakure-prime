# @kakure/cli

`kakure`: the command-line client for a shielded FROST-multisig treasury on Solana. Wraps
`@kakure/sdk` (keys, notes, FROST, DKG) and `@kakure/prover` (local Groth16 proving) with a
config file, an encrypted keystore, and the coordinator/indexer HTTP clients (I-7/I-8).

## Install / build

```sh
pnpm --filter @kakure/cli build
node dist/cli.js --help
```

## Config

`~/.kakure/config.json` (override the directory with `KAKURE_CONFIG_DIR`):

```json
{
  "network": "http://127.0.0.1:8899",
  "coordinatorUrl": "http://127.0.0.1:8788",
  "indexerUrl": "http://127.0.0.1:8787",
  "programId": "11111111111111111111111111111111"
}
```

Keys are encrypted at rest (`~/.kakure/keystore.json` by default): scrypt (N=2^15, r=8, p=1) ->
XChaCha20-Poly1305 (`@noble/ciphers`) over the raw Solana `Keypair` secret bytes, file mode 0600.
Passphrase prompts read from stdin, or `KAKURE_PASSPHRASE` (tests / non-interactive use only).

## Commands

| Command | What it does | Status |
|---|---|---|
| `kakure keygen [--keystore <path>]` | Generate an ed25519 keypair, write the encrypted keystore. | Real. |
| `kakure group create --threshold <t> --members <n> [--keystore] [--group-store]` | Start a group DKG session (`@kakure/sdk/tss`'s Feldman VSS + Schnorr PoP), print the session id to share, derive and store the group's canonical view key. | Real (see "DKG" below). |
| `kakure group join <session> --threshold <t> --members <n> [--keystore] [--group-store]` | Join an existing DKG session. | Real. |
| `kakure balance --group-store <path>` | Group note balances, by asset, via `@kakure/sdk`'s `MultisigScanEngine` over the indexer (I-8). | Real. |
| `kakure deposit --mint <pubkey> --amount <amount>` | Mint a personal self note and build the `deposit` instruction. | Real (single-key deposit path; see the "Known limitations" note in `commands/deposit.ts` about bypassing `SelfMintPreflight`). |
| `kakure propose {transfer\|split\|join\|withdraw} --session <id> --message <hex> [--details <json>]` | Post a spend proposal to the group's session. | Real for the coordinator-relay/state-machine half. The CLI's own `propose transfer` subcommand still expects a pre-computed `--message`; the "assemble the witness, then propose" pipeline (`assembleTransferMultisig` + `createTransferMultisigProposal`) is implemented and tested (see `proposal/__tests__/transferMultisigFlow.test.ts`) but not yet wired to this CLI subcommand's argument surface -- see "Known limitations". |
| `kakure sign <proposal> --session <id> --group-store <path>` | FROST round 1 + round 2 over the real BabyJubJub-Poseidon2 ciphersuite (`@kakure/sdk/frost`). | Real. |
| `execute` | Aggregate shares -> assemble/prove/build -> (optionally) send. | Real as a library (`proposal/execute.ts` + `proposal/transferMultisigProposal.ts`, tested end-to-end against a real DKG + real FROST aggregate + a fake `ProverPort`, plus one opt-in test against the REAL `@kakure/prover`); not yet wired as its own `kakure execute` CLI subcommand -- see "Known limitations". |

## What "real" means here (exact scope)

- **DKG** (`dkg/ceremony.ts`, over `@kakure/sdk/tss`'s `dealerContribute`/`verifyContribution`/
  `aggregate`): a genuine dealerless Feldman VSS + Schnorr proof-of-possession ceremony, run over
  the coordinator (I-7). Two members' shares Lagrange-reconstruct to a secret whose `G`-multiple
  equals the published `gpk` (`dkg/__tests__/ceremony.test.ts`).
- **Canonical group view key** (`commands/group.ts`): every member's round-2 sealed payload also
  carries a random 32-byte `r_i`; once the ceremony resolves, `@kakure/sdk/tss`'s
  `combineGroupViewContributions` combines every dealer's `r_i` into the group's shared secret
  `gvs`, and `@kakure/sdk/frost`'s `deriveGroupViewKeyFromSecret(gvs, gpk)` turns that into `(v,
  V)` -- IDENTICAL for every member (unlike the deprecated per-account `deriveGroupViewKey`).
  Verified in `commands/__tests__/group.test.ts`: two independently-running members converge on
  the same `gvs`/`v`/`V`.
- **FROST signing** (`proposal/proposal.ts`): real round-1 `commit` / round-2 `signShare` /
  `coordinatorAggregate` from `@kakure/sdk/frost`'s BabyJubJub-Poseidon2 ciphersuite. The
  aggregated signature verifies with `@kakure/sdk/frost`'s own `verify()`
  (`proposal/__tests__/proposal.test.ts`).
- **Note assembly** (`proposal/assembleTransferMultisig.ts`): real `transfer_multisig` witness
  construction -- opens the spent note via a `MerkleWitnessSource`, mints the memo (
  `mintIncomingNote`) and change (`mintSelfNoteMultisig`, an app-level helper mirroring
  `note/mint.ts`'s `finish()` with the multisig owner) notes, and computes the REAL `msg_transfer`
  (`@kakure/sdk/frost`'s `msgTransfer`) that the FROST signature must cover -- so the signature
  signers produce is over the actual bytes the circuit checks, not a placeholder.
  `split_multisig`/`join_multisig`/`withdraw_multisig` are NOT implemented; same pattern, not
  ported given time (see below).
- **`execute`** (`proposal/execute.ts`): aggregate -> `buildInputs` -> `prover.prove(...)` ->
  `buildInstructions` -> optional send. Tested with a fake `ProverPort` returning a canned
  `ProofBundle` (fast, runs on every `pnpm test`) AND with the real `@kakure/prover` behind
  `KAKURE_CLI_REAL_PROVER_TEST=1` (`proposal/__tests__/transferMultisigFlow.real.test.ts`, skipped
  by default -- proving takes minutes).
- **`deposit`** (`commands/deposit.ts`): real `mintSelfNote` + `prove(CircuitId.Deposit, ...)` +
  `TxBuilder.deposit()`, tested with a fake `ProverPort` (`commands/__tests__/deposit.test.ts`).

## Known limitations (exact, not glossed over)

1. **`deposit` bypasses `SelfMintPreflight`.** `@kakure/sdk`'s `tx/assemble.ts`'s `assembleDeposit`
   requires a `SelfMintAuthorization`, obtainable only via `SelfMintPreflight` + a `DiscoverySource`
   (Howl/Raven private discovery -- explicitly OUT of v1 scope per the design spec). `deposit.ts`
   instead calls `mintSelfNote` directly (exported from `@kakure/sdk/unsafe-sim`) with an index
   reserved from a durable `EphemeralCounterStore`. Safe for a single CLI-managed keystore never
   used concurrently from two devices; NOT the sdk's intended multi-device-safe path.
2. **Only `transfer_multisig` has real assembly.** `split_multisig`/`join_multisig`/
   `withdraw_multisig` need the same treatment (open the note(s), mint the outputs, compute
   `msgSplit`/`msgJoin`/`msgWithdraw`) but weren't ported under this task's time budget.
3. **The `propose`/`execute` CLI subcommands aren't wired to the assembly layer yet.** The
   library functions (`assembleTransferMultisig`, `createTransferMultisigProposal`,
   `buildTransferMultisigInputsFromProposal`, `executeProposal`) are real, tested, and compose into
   a full flow (see `proposal/__tests__/transferMultisigFlow.test.ts`), but `cli.ts`'s `propose
   transfer` subcommand still takes a raw `--message` flag instead of running the assembly step
   itself, and there is no `kakure execute <proposal>` subcommand yet -- both are argument-parsing
   work, not missing logic.
4. **`balance` uses `MultisigScanEngine`, not `ScanEngine`.** `ScanEngine` (single-key scanning)
   is now buildable too -- `IKeyRepository`/`IUtxoRepository`/`WalletNote`/`KeyRepository`/
   `UtxoRepository` are exported from `@kakure/sdk`'s main barrel as of the sdk's
   `f380fd4` -- but `balance` wasn't switched to also cover single-key personal wallets (only
   group/multisig balances) given time; the multisig path is the one that matters for a treasury
   CLI.

## DKG: dedupe status -- DONE

`dkg/feldman.ts` (the from-scratch Feldman VSS + Schnorr PoP reimplementation this package
carried while `@kakure/sdk` had no `./tss` export) has been **deleted**. `dkg/ceremony.ts` now
imports `dealerContribute`/`verifyContribution`/`aggregate`/`DealerContribution`/`Point` directly
from `@kakure/sdk/tss`; `dkg/publicShare.ts` keeps only the two small app-level helpers
(`publicShareAt`/`aggregatePublicShareAt` -- computing a participant's public share from public
commitments alone, not part of `@kakure/sdk/tss` itself) built on top of the SDK's real
`scalarMul`/`pointAdd`/`modSub`/`IDENTITY`. `dkg/__tests__/ceremony.test.ts`,
`proposal/__tests__/{proposal,execute}.test.ts`, and `proposal/__tests__/transferMultisigFlow*
.test.ts` were all updated to import from `@kakure/sdk/tss` and pass; no crypto logic is
duplicated between this package and the sdk anymore.

## Test

```sh
pnpm --filter @kakure/cli test                                    # fast suite (fakes only)
KAKURE_CLI_REAL_PROVER_TEST=1 pnpm --filter @kakure/cli test       # + the real-prover e2e test
```

`vitest run --pool=forks --poolOptions.forks.maxForks=2` (baked into the `test` script) --
this sandbox is RAM-constrained; keep proving to one process at a time.
