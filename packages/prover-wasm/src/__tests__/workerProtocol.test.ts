import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitId, PUBLIC_INPUT_COUNT } from "@kakure/sdk/tx";
import { wasmProverPort } from "../wasmProver.js";

class FakeWorker {
  static messages: Array<{ message: Record<string, unknown>; transfer?: Transferable[] }> = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_url: string | URL, _options?: WorkerOptions) {}

  postMessage(message: Record<string, unknown>, transfer?: Transferable[]): void {
    FakeWorker.messages.push({ message, ...(transfer ? { transfer } : {}) });
    queueMicrotask(() => {
      if (message.type === "init") {
        this.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));
      } else if (message.type === "prepare") {
        this.onmessage?.(
          new MessageEvent("message", { data: { type: "prepared", requestId: message.requestId } }),
        );
      } else if (message.type === "prove") {
        const count = PUBLIC_INPUT_COUNT[message.circuit as CircuitId];
        this.onmessage?.(
          new MessageEvent("message", {
            data: {
              type: "result",
              requestId: message.requestId,
              proof: new ArrayBuffer(192),
              publicInputs: Array.from({ length: count }, () => new ArrayBuffer(32)),
            },
          }),
        );
      }
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.messages = [];
});

describe("wasmProverPort worker protocol", () => {
  it("prepares and transfers a circuit once, then reuses it for later proofs", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const artifactsFor = vi.fn(async () => ({
      acirJson: "{}",
      ccsBytes: new Uint8Array([1, 2, 3]),
      pkBytes: new Uint8Array([4, 5, 6]),
    }));
    const port = wasmProverPort({
      wasmBytes: new ArrayBuffer(8),
      circuits: [CircuitId.Withdraw],
      artifactsFor,
      worker: true,
      workerUrl: "worker.js",
    });

    await port.prepare(CircuitId.Withdraw);
    await port.prove(CircuitId.Withdraw, {});
    await port.prove(CircuitId.Withdraw, {});

    expect(artifactsFor).toHaveBeenCalledTimes(1);
    expect(FakeWorker.messages.map(({ message }) => message.type)).toEqual([
      "init",
      "prepare",
      "prove",
      "prove",
    ]);
    const prepare = FakeWorker.messages[1]!;
    expect(prepare.transfer).toHaveLength(2);
    expect(prepare.message.ccsBytes).toBeInstanceOf(ArrayBuffer);
    expect(prepare.message.pkBytes).toBeInstanceOf(ArrayBuffer);
    expect(FakeWorker.messages[2]!.message).not.toHaveProperty("pkBytes");
  });
});
