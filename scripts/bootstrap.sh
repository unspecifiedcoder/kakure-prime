#!/usr/bin/env bash
# Kakure one-shot environment bootstrap (Linux x86_64, Debian/Ubuntu).
# Installs the pinned toolchain, downloads prebuilt circuit/program artifacts,
# installs JS deps and builds the workspace. Idempotent; safe to re-run.
#
#   bash scripts/bootstrap.sh            # full setup
#   SKIP_ARTIFACTS=1 bash scripts/bootstrap.sh   # toolchain only
set -euo pipefail

NARGO_VERSION="1.0.0-beta.22"
GO_VERSION="1.24.6"
SUNSPOT_REPO="https://github.com/reilabs/sunspot.git"
SUNSPOT_COMMIT="43891c5"
SOLANA_VERSION="3.0.0"
ARTIFACTS_RELEASE="artifacts-v1"
REPO_SLUG="unspecifiedcoder/kakure"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "System packages"
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq build-essential pkg-config libssl-dev libudev-dev curl git jq clang llvm
fi

log "Rust (stable)"
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
export PATH="$HOME/.cargo/bin:$PATH"

log "Go $GO_VERSION"
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go$GO_VERSION"; then
  curl -sSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz
fi
export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"

log "Noir $NARGO_VERSION"
if ! "$HOME/.nargo/bin/nargo" --version 2>/dev/null | grep -q "$NARGO_VERSION"; then
  curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
  "$HOME/.nargo/bin/noirup" -v "$NARGO_VERSION"
fi
export PATH="$HOME/.nargo/bin:$PATH"

log "Solana CLI $SOLANA_VERSION (Agave)"
if ! solana --version 2>/dev/null | grep -q "$SOLANA_VERSION"; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v${SOLANA_VERSION}/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

log "Sunspot @ $SUNSPOT_COMMIT"
if [ ! -d "$HOME/sunspot" ]; then
  git clone -q "$SUNSPOT_REPO" "$HOME/sunspot"
fi
(cd "$HOME/sunspot" && git fetch -q && git checkout -q "$SUNSPOT_COMMIT")
if ! command -v sunspot >/dev/null; then
  (cd "$HOME/sunspot/go" && go build -o sunspot ./cmd/sunspot && sudo cp sunspot /usr/local/bin/sunspot)
fi
export GNARK_VERIFIER_BIN="$HOME/sunspot/gnark-solana/crates/verifier-bin"

log "Node 22 + pnpm 10"
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y -qq nodejs
fi
corepack enable >/dev/null 2>&1 || sudo npm i -g corepack
corepack prepare pnpm@10.24.0 --activate

if [ "${SKIP_ARTIFACTS:-0}" != "1" ]; then
  log "Prebuilt artifacts ($ARTIFACTS_RELEASE)"
  if [ ! -f circuits/target/transfer_multisig.pk ]; then
    url="https://github.com/${REPO_SLUG}/releases/download/${ARTIFACTS_RELEASE}/kakure-artifacts-v1.tar.gz"
    if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
      gh release download "$ARTIFACTS_RELEASE" -R "$REPO_SLUG" -p 'kakure-artifacts-v1.tar.gz' -D /tmp --clobber
    else
      curl -sSL -o /tmp/kakure-artifacts-v1.tar.gz "$url"
    fi
    tar -xzf /tmp/kakure-artifacts-v1.tar.gz -C "$ROOT"
  fi
  ls circuits/target/*.so >/dev/null
fi

log "JS workspace"
pnpm install
pnpm -r --if-present build

log "Sanity"
nargo --version | head -1
sunspot --help | head -1
solana --version
echo "OK — run: just e2e-scenario   (core)   |   just e2e-payroll   (web app demo)"
