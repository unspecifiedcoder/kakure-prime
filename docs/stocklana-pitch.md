# Kakure Prime — final proof-first pitch

The current narration source is [`apps/web/scripts/pitch-narration.txt`](../apps/web/scripts/pitch-narration.txt), and the deterministic recorder is [`apps/web/scripts/record-final-pitch.mjs`](../apps/web/scripts/record-final-pitch.mjs).

## Voice-over

The checked-in narration is the source of truth. It deliberately distinguishes the public deposit and withdrawal boundaries from the private settlement interior, identifies the three finalized Devnet transactions and their matching verifier programs, and states the present sponsor-integration limits without implying mainnet readiness.

Pronunciation spellings in the narration source are converted back to `Kakure`, `Pyth`, `PreStocks`, `Meteora`, `Groth16`, and `FROST` in the generated subtitles. Run `scripts/render-final-pitch.sh` from WSL after recording the silent browser sequence to reproduce both video formats.

## Recording sequence

1. State the institutional privacy problem on the product home.
2. Hold on the above-the-fold deposit → private transfer → withdrawal proof rail.
3. Open `/#/evidence` and show the three finalized transactions, three matching verifier programs, and negative-path rejections.
4. Open `/#/demo` and show live PreStocks, Pyth, Meteora, and protocol evidence.
5. Advance through the five-step guided lifecycle.
6. Hold on the public-versus-authorized-quorum comparison.
7. Close on the real Devnet proof rail and direct inspection call to action.

The guided clicks remain explicitly labelled as simulated. The pitch instead identifies the three separately linked public Devnet transactions as the real on-chain lifecycle.
