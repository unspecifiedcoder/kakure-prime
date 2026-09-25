import { Connection, PublicKey } from "@solana/web3.js";
import type { ChainSource, RawTransaction, SignatureInfo } from "./types.js";

/** `@solana/web3.js`-backed `ChainSource`. Talks to a real cluster over JSON-RPC + websocket. */
export class SolanaChainSource implements ChainSource {
  private readonly connection: Connection;

  constructor(rpcUrl: string, wsUrl?: string) {
    this.connection = wsUrl
      ? new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl })
      : new Connection(rpcUrl, { commitment: "confirmed" });
  }

  async getSignaturesForAddress(
    address: string,
    opts?: { before?: string; until?: string; limit?: number },
  ): Promise<SignatureInfo[]> {
    const pubkey = new PublicKey(address);
    const rpcOpts: { before?: string; until?: string; limit: number } = {
      limit: opts?.limit ?? 1000,
    };
    if (opts?.before !== undefined) rpcOpts.before = opts.before;
    if (opts?.until !== undefined) rpcOpts.until = opts.until;
    const results = await this.connection.getSignaturesForAddress(pubkey, rpcOpts);
    return results.map((r) => ({ signature: r.signature, slot: r.slot, err: r.err }));
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return null;

    return {
      signature,
      slot: tx.slot,
      err: tx.meta?.err ?? null,
      logMessages: tx.meta?.logMessages ?? [],
    };
  }

  onLogs(address: string, callback: (info: SignatureInfo) => void): () => void {
    const pubkey = new PublicKey(address);
    // `Connection.onLogs`'s callback is `(logs, context) => void` -- `context.slot` is the real
    // slot the logs were observed at. This used to hardcode `slot: 0` for every live-tail event,
    // discarding it. Real bug this caused (found running the real e2e scenario): every live-tail
    // NoteInserted got persisted with slot 0, so once more than one leaf was ever inserted,
    // `IndexerStore.getLatestRoot()`'s `ORDER BY slot DESC LIMIT 1` could no longer tell which
    // root was actually latest (every row tied on slot=0) and would non-deterministically return
    // a STALE root -- `GET /root` then disagreed with `GET /path/:leaf_index` (which folds
    // correctly, since it reads the live in-memory tree directly), surfacing as
    // `IndexerWitnessSource`'s `ROOT_MISMATCH` self-check failing deterministically once a second
    // leaf existed.
    const id = this.connection.onLogs(
      pubkey,
      (logs, context) => {
        callback({ signature: logs.signature, slot: context.slot, err: logs.err });
      },
      "confirmed",
    );
    return () => {
      void this.connection.removeOnLogsListener(id);
    };
  }
}
