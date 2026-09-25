import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MessageStore } from "../db/store.js";
import { createLogger } from "../logger.js";
import { buildCoordinatorApi, type CoordinatorApi } from "./server.js";

const sid = "a".repeat(64);

function envelopeBody(seq: number, ciphertext = "aGk=") {
  return { session_id: sid, seq, kind: "dkg1" as const, ciphertext };
}

describe("coordinator HTTP + WS API (I-7)", () => {
  let store: MessageStore;
  let api: CoordinatorApi;

  beforeEach(() => {
    store = new MessageStore();
    api = buildCoordinatorApi({ store, logger: createLogger(() => {}), longPollTimeoutMs: 300 });
  });

  afterEach(async () => {
    await api.app.close();
  });

  it("POST appends then GET returns the envelope", async () => {
    const post = await api.app.inject({
      method: "POST",
      url: `/sessions/${sid}/messages`,
      payload: envelopeBody(0),
    });
    expect(post.statusCode).toBe(201);

    const get = await api.app.inject({ method: "GET", url: `/sessions/${sid}/messages` });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual([envelopeBody(0)]);
  });

  it("GET ?since= filters to newer messages", async () => {
    await api.app.inject({ method: "POST", url: `/sessions/${sid}/messages`, payload: envelopeBody(0) });
    await api.app.inject({ method: "POST", url: `/sessions/${sid}/messages`, payload: envelopeBody(1) });
    const res = await api.app.inject({ method: "GET", url: `/sessions/${sid}/messages?since=0` });
    expect(res.json()).toEqual([envelopeBody(1)]);
  });

  it("rejects an invalid envelope body", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: `/sessions/${sid}/messages`,
      payload: { session_id: sid, seq: 0, kind: "bogus", ciphertext: "aGk=" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a session_id/URL mismatch", async () => {
    const res = await api.app.inject({
      method: "POST",
      url: `/sessions/${sid}/messages`,
      payload: envelopeBody(0),
    }); // sanity baseline
    expect(res.statusCode).toBe(201);
    const mismatch = await api.app.inject({
      method: "POST",
      url: `/sessions/${"b".repeat(64)}/messages`,
      payload: envelopeBody(1),
    });
    expect(mismatch.statusCode).toBe(400);
  });

  it("rejects a sequence conflict with 409", async () => {
    await api.app.inject({ method: "POST", url: `/sessions/${sid}/messages`, payload: envelopeBody(0) });
    const res = await api.app.inject({
      method: "POST",
      url: `/sessions/${sid}/messages`,
      payload: envelopeBody(0),
    });
    expect(res.statusCode).toBe(409);
  });

  it("long-poll resolves early when a new message is appended", async () => {
    const getPromise = api.app.inject({ method: "GET", url: `/sessions/${sid}/messages?since=-1` });
    // give the GET a tick to subscribe before the POST fires
    await new Promise((r) => setTimeout(r, 20));
    await api.app.inject({ method: "POST", url: `/sessions/${sid}/messages`, payload: envelopeBody(0) });

    const res = await getPromise;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([envelopeBody(0)]);
  });

  it("long-poll times out to an empty array when nothing arrives", async () => {
    const res = await api.app.inject({ method: "GET", url: `/sessions/${sid}/messages` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("WS pushes newly appended envelopes to subscribers", async () => {
    api.attachWebSocket();
    const address = await api.app.listen({ port: 0, host: "127.0.0.1" });
    const wsUrl = address.replace("http://", "ws://") + `/sessions/${sid}`;

    const ws = new WebSocket(wsUrl);
    const received = new Promise<unknown>((resolve, reject) => {
      ws.on("message", (data: Buffer) => resolve(JSON.parse(data.toString())));
      ws.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    await api.app.inject({ method: "POST", url: `/sessions/${sid}/messages`, payload: envelopeBody(0) });

    const msg = await received;
    expect(msg).toEqual(envelopeBody(0));
    ws.close();
  });

  // slice-2 F-8
  it("returns 413 for an oversized envelope body", async () => {
    const hugeCiphertext = "A".repeat(100 * 1024); // 100 KiB, well over the ~64 KiB cap
    const res = await api.app.inject({
      method: "POST",
      url: `/sessions/${sid}/messages`,
      payload: envelopeBody(0, hugeCiphertext),
    });
    expect(res.statusCode).toBe(413);
  });

  it("returns 400 for a non-numeric since", async () => {
    const res = await api.app.inject({ method: "GET", url: `/sessions/${sid}/messages?since=abc` });
    expect(res.statusCode).toBe(400);
  });
});
