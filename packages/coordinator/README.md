# @kakure/coordinator

E2E-encrypted relay for DKG rounds, spend proposals and FROST round-1/round-2 messages
(spec §5 "Coordinator privacy contract", plan I-7). Stores and relays ciphertext only.

## Run

```sh
pnpm --filter @kakure/coordinator build
node dist/cli.js --port 8788 --db ./kakure-coordinator.sqlite
```

Flags:

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--port` | no | `8788` | HTTP + WS port |
| `--db` | no | `./kakure-coordinator.sqlite` | SQLite file (use `:memory:` for tests/dev) |

## API (I-7)

Envelope: `{ session_id: string /* hex32 */, seq: number, kind: "dkg1"|"dkg2"|"proposal"|"nonce"|"share"|"final", ciphertext: string /* base64 */ }`

- `POST /sessions/:id/messages` — body is an `Envelope` whose `session_id` must equal `:id`;
  `seq` must be exactly the next sequence number for that session (0-based). `201` on success,
  `400` on a malformed envelope or `session_id`/`:id` mismatch, `409` on a sequence conflict.
- `GET /sessions/:id/messages?since=<seq>` — long-polls up to 25s: returns immediately with any
  envelopes where `seq > since`, otherwise waits for a new append or times out to `[]`.
- `WS /sessions/:id` — pushes every newly appended envelope for that session as a JSON text frame.

## Privacy contract

The coordinator never logs a session id and a timestamp on the same line — see
`src/logger.ts`: `logSession(event, sessionId)` has no parameter through which a timestamp could
be attached, and `logTiming(event, value)` has no parameter through which a session id could be
attached. This is enforced by the function signatures, not by convention; `src/logger.test.ts`
also verifies it empirically across a simulated request flow.

## Test

```sh
pnpm --filter @kakure/coordinator test
```
