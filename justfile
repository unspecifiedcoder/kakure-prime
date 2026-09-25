# Kakure task runner. Workstreams append their own targets below their marker.
set shell := ["bash", "-euo", "pipefail", "-c"]

export PATH := env_var("HOME") + "/.nargo/bin:/usr/local/go/bin:" + env_var("HOME") + "/.cargo/bin:" + env_var("HOME") + "/.avm/bin:/usr/local/bin:" + env_var("PATH")
export GNARK_VERIFIER_BIN := env_var("HOME") + "/sunspot/gnark-solana/crates/verifier-bin"

default:
    @just --list

test:
    pnpm test

# --- workstream A: circuits ---
CIRCUIT_NAMES := "deposit transfer withdraw transfer_multisig split_multisig join_multisig withdraw_multisig"

# Compile all 7 v1 circuits, run Sunspot compile/setup/deploy (dev, INSECURE-DEV toxic waste),
# and regenerate circuits/manifest.json. Produces circuits/target/<name>.{json,ccs,pk,vk,so}.
build-circuits:
    #!/usr/bin/env bash
    set -euo pipefail
    cd circuits
    mkdir -p target
    for name in {{CIRCUIT_NAMES}}; do
      echo "== $name: nargo compile =="
      nargo compile --package "$name" --silence-warnings
      echo "== $name: sunspot compile =="
      (cd target && sunspot compile "$name.json")
      echo "== $name: sunspot setup (dev, INSECURE-DEV) =="
      (cd target && sunspot setup "$name.ccs")
      echo "== $name: sunspot deploy =="
      (cd target && sunspot deploy "$name.vk")
    done
    just build-manifest

# Regenerate circuits/manifest.json from the built .vk files (does not rebuild circuits).
build-manifest:
    cd circuits && node scripts/gen_manifest.mjs

# Execute the transfer_multisig KAT witness (kat_multisig_transfer_accepts fixtures, via
# circuits/multisig/transfer_multisig/Prover.toml) and prove+verify it through Sunspot end to
# end. Requires `just build-circuits` (or at least transfer_multisig's .ccs/.pk/.vk) to exist.
verify-kat:
    #!/usr/bin/env bash
    set -euo pipefail
    cd circuits
    name=transfer_multisig
    echo "== $name: nargo execute (KAT witness) =="
    nargo execute --package "$name" --silence-warnings
    echo "== $name: sunspot prove =="
    (cd target && sunspot prove "$name.json" "$name.gz" "$name.ccs" "$name.pk")
    echo "== $name: sunspot verify =="
    (cd target && sunspot verify "$name.vk" "$name.proof" "$name.pw")

# --- workstream B: program ---

# Reproducible build for the two Solana programs this repo ships (F8 fix): rebuilds
# `kakure_pool` (release, NO `dev-verify` feature -- see processor.rs's `VerifyOnly` gate) and
# `mock_verifier` with `cargo build-sbf`, straight into `programs/deploy/` (the directory the
# committed `.so`s live in and `e2e/localnet.ts` genesis-loads, NOT `target/deploy`).
build-programs:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build-sbf --manifest-path programs/kakure_pool/Cargo.toml --sbf-out-dir programs/deploy -- --locked
    cargo build-sbf --manifest-path programs/mock_verifier/Cargo.toml --sbf-out-dir programs/deploy -- --locked

# Same, but WITH the `dev-verify` feature (see programs/kakure_pool/Cargo.toml's doc comment on
# that feature for why it must never ship): output goes to a clearly-separate directory so it can
# never be mistaken for -- or accidentally committed as -- the real deploy artifact.
build-programs-dev-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p target/deploy-dev-verify
    cargo build-sbf --manifest-path programs/kakure_pool/Cargo.toml --features dev-verify --sbf-out-dir target/deploy-dev-verify -- --locked

# CI gate for F8: rebuilds both programs into a scratch directory and `sha256sum -c`s the result
# against the COMMITTED `programs/deploy/*.so` -- fails if the tracked binaries were not produced
# by this exact reproducible build (staleness, hand-edited artifact, or a `dev-verify` build
# committed by mistake all fail this check).
verify-programs-reproducible:
    #!/usr/bin/env bash
    set -euo pipefail
    scratch="$(mktemp -d)"
    trap 'rm -rf "$scratch"' EXIT
    cargo build-sbf --manifest-path programs/kakure_pool/Cargo.toml --sbf-out-dir "$scratch" -- --locked
    cargo build-sbf --manifest-path programs/mock_verifier/Cargo.toml --sbf-out-dir "$scratch" -- --locked
    for so in kakure_pool.so mock_verifier.so; do
      committed_sum="$(sha256sum "programs/deploy/$so" | awk '{print $1}')"
      rebuilt_sum="$(sha256sum "$scratch/$so" | awk '{print $1}')"
      if [ "$committed_sum" != "$rebuilt_sum" ]; then
        echo "REPRODUCIBILITY FAILURE: programs/deploy/$so ($committed_sum) != freshly rebuilt $so ($rebuilt_sum)"
        exit 1
      fi
      echo "OK: programs/deploy/$so matches a fresh reproducible build ($committed_sum)"
    done

# --- workstream D: prover/cli ---
build-prover:
    pnpm --filter @kakure/prover build

build-cli:
    pnpm --filter @kakure/cli build

build-ws-d: build-prover build-cli

test-prover:
    pnpm --filter @kakure/prover test

test-cli:
    pnpm --filter @kakure/cli test

test-ws-d: test-prover test-cli
# --- workstream E: services ---
build-services:
    pnpm --filter @kakure/indexer --filter @kakure/coordinator build

test-indexer:
    pnpm --filter @kakure/indexer test

test-coordinator:
    pnpm --filter @kakure/coordinator test

test-services: test-indexer test-coordinator
# --- workstream F: e2e ---
# Build order matters: e2e/apps/dashboard both import @kakure/sdk via its published `dist/` exports, and
# the harness spawns the indexer/coordinator CLIs from their built `dist/cli.js`. The real scenario also
# needs the prover (real Groth16 proofs) and cli (DKG ceremony + multisig proposal assembly) built.
build-f-deps:
    pnpm --filter @kakure/sdk build
    pnpm --filter @kakure/indexer --filter @kakure/coordinator build
    pnpm --filter @kakure/prover --filter @kakure/cli build

# One `solana-test-validator` at a time on this sandbox: never run this alongside e2e-scenario or another
# agent's validator.
e2e-smoke: build-f-deps
    pnpm --filter @kakure/e2e exec vitest run smoke.test.ts --no-file-parallelism

# Real end to end against real Groth16 proofs (spec §7): steps 1-4 (init, real 5-signer DKG over
# the real coordinator, real deposit proof, real MultisigScanEngine find) and 7c (insufficient-
# quorum FROST) are green. Steps 5-7b are genuinely blocked, not a harness bug: transfer_multisig/
# split_multisig/transfer's real proof + 24(or 22) public inputs cannot fit in one Solana
# transaction under the current wire format, even with an Address Lookup Table -- see
# docs/superpowers/plans/2026-09-05-ws-f2-scenario.md's "Genuine blocker" section for the exact
# byte math. Generous timeouts: this proves real circuits (minutes each) and runs a real DKG.
e2e-scenario: build-f-deps
    pnpm --filter @kakure/e2e exec vitest run scenario.test.ts --no-file-parallelism --testTimeout=900000 --hookTimeout=180000

# --- workstream I: customer web app (replaces the old dashboard-* targets) ---
web-build:
    pnpm --filter @kakure/sdk --filter @kakure/prover --filter @kakure/prover-wasm --filter @kakure/cli --filter @kakure/helper build
    pnpm --filter @kakure/web build

web-dev:
    pnpm --filter @kakure/sdk --filter @kakure/prover --filter @kakure/prover-wasm --filter @kakure/cli --filter @kakure/helper build
    pnpm --filter @kakure/web dev

test-web:
    pnpm --filter @kakure/sdk --filter @kakure/prover --filter @kakure/prover-wasm --filter @kakure/cli --filter @kakure/helper build
    pnpm --filter @kakure/web exec vitest run --no-file-parallelism

# Local Kakure Helper (spec §3B): a small HTTP prover service on 127.0.0.1, per-launch bearer token
# printed on startup. Never run two at once on the same port.
helper-dev:
    pnpm --filter @kakure/sdk --filter @kakure/prover --filter @kakure/helper build
    pnpm --filter @kakure/helper exec node dist/cli.js

# Playwright e2e (spec §6): the payroll demo flow against a real localnet + helper. One
# `solana-test-validator` at a time on this sandbox -- never alongside e2e-scenario or another
# agent's validator.
e2e-payroll: web-build
    pnpm --filter @kakure/web exec playwright test
