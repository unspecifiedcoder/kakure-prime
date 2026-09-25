/**
 * HTTP client for the coordinator's I-7 API. Intentionally has no notion of encryption -- callers
 * hand it envelopes whose `ciphertext` is already sealed (or, for the DKG round-1 identity
 * announce, base64 plaintext -- see `src/dkg/announce.ts`); the coordinator only ever sees
 * ciphertext, seq numbers and timing (spec's coordinator privacy contract).
 */
export interface Envelope {
  session_id: string;
  seq: number;
  kind: "dkg1" | "dkg2" | "proposal" | "nonce" | "share" | "final";
  ciphertext: string;
}

export class SequenceConflictError extends Error {
  constructor(sessionId: string) {
    super(`coordinator: sequence conflict appending to session ${sessionId}`);
    this.name = "SequenceConflictError";
  }
}

export class CoordinatorClient {
  // Optimistic next-seq guess per session, so the happy path on an EMPTY session never has to
  // long-poll (`pollOnce(id, -1)` on an empty session blocks up to ~25s per I-7) just to learn
  // that the next seq is 0.
  private readonly nextSeqGuess = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async append(envelope: Envelope): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/sessions/${envelope.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (res.status === 409) throw new SequenceConflictError(envelope.session_id);
    if (!res.ok) {
      throw new Error(`CoordinatorClient.append: HTTP ${res.status}: ${await res.text()}`);
    }
  }

  /** One long-poll round (I-7: up to ~25s, returns [] on timeout). */
  async pollOnce(sessionId: string, since: number): Promise<Envelope[]> {
    const res = await this.fetchFn(
      `${this.baseUrl}/sessions/${sessionId}/messages?since=${since}`,
    );
    if (!res.ok) {
      throw new Error(`CoordinatorClient.pollOnce: HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Envelope[];
  }

  /**
   * `seq` is a SINGLE strictly-increasing counter per session (I-7), shared across every sender --
   * not one stream per member. Concurrent appenders therefore race for the next slot and must
   * retry on `409`. This helper does that: read the highest known `seq` (a fresh `since=-1` poll,
   * bounded by a short timeout the fake/real server both honour), try `seq = highest + 1`, and on
   * a conflict re-read and retry.
   */
  async appendNext(
    sessionId: string,
    kind: Envelope["kind"],
    ciphertext: string,
    maxAttempts = 20,
  ): Promise<Envelope> {
    let nextSeq = this.nextSeqGuess.get(sessionId) ?? 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const envelope: Envelope = { session_id: sessionId, seq: nextSeq, kind, ciphertext };
      try {
        await this.append(envelope);
        this.nextSeqGuess.set(sessionId, nextSeq + 1);
        return envelope;
      } catch (err) {
        if (!(err instanceof SequenceConflictError) || attempt === maxAttempts - 1) throw err;
        // Someone else took `nextSeq` (or an earlier slot is still missing) -- this poll returns
        // immediately, the session is non-empty by definition of hitting a 409.
        const existing = await this.pollOnce(sessionId, -1);
        nextSeq = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.seq)) + 1;
        this.nextSeqGuess.set(sessionId, nextSeq);
      }
    }
    throw new SequenceConflictError(sessionId);
  }

  /**
   * Repeatedly long-polls until `predicate(all)` is true or `maxRounds` is exhausted, returning
   * every envelope seen so far (sorted by `seq`). Used to collect a DKG round's messages from all
   * participants without the CLI needing its own WS client.
   */
  async collectUntil(
    sessionId: string,
    predicate: (envelopes: Envelope[]) => boolean,
    opts: { maxRounds?: number; startSeq?: number } = {},
  ): Promise<Envelope[]> {
    const maxRounds = opts.maxRounds ?? 40;
    let since = opts.startSeq ?? -1;
    const seen = new Map<number, Envelope>();
    for (let round = 0; round < maxRounds; round++) {
      const batch = await this.pollOnce(sessionId, since);
      for (const e of batch) {
        seen.set(e.seq, e);
        if (e.seq > since) since = e.seq;
      }
      const all = [...seen.values()].sort((a, b) => a.seq - b.seq);
      if (predicate(all)) return all;
    }
    throw new Error(
      `CoordinatorClient.collectUntil: predicate never satisfied after ${maxRounds} long-poll rounds on session ${sessionId}`,
    );
  }
}
