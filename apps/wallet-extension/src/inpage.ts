type Handler = (...args: unknown[]) => void;

const pending = new Map<string, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
const listeners = new Map<string, Set<Handler>>();

window.addEventListener("kakure:response", ((event: CustomEvent) => {
  const request = pending.get(event.detail.id);
  if (!request) return;
  pending.delete(event.detail.id);
  if (event.detail.ok) request.resolve(event.detail.result);
  else request.reject(new Error(event.detail.error));
}) as EventListener);

function request(method: string, params?: unknown): Promise<any> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.dispatchEvent(new CustomEvent("kakure:request", { detail: { id, method, params } }));
  });
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const provider = {
  isKakure: true,
  publicKey: null as null | { toBase58(): string; toString(): string },
  async connect() {
    const result = await request("connect");
    this.publicKey = { toBase58: () => result.publicKey, toString: () => result.publicKey };
    listeners.get("connect")?.forEach((handler) => handler(this.publicKey));
    return { publicKey: this.publicKey };
  },
  async disconnect() {
    this.publicKey = null;
    listeners.get("disconnect")?.forEach((handler) => handler());
  },
  async signMessage(message: Uint8Array) {
    const result = await request("signMessage", { message: encode(message) });
    return { signature: decode(result.signature), publicKey: this.publicKey };
  },
  async signTransaction(transaction: any) {
    const versioned = typeof transaction.version !== "undefined";
    const result = await request("signTransaction", { transaction: encode(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })), versioned });
    const bytes = decode(result.transaction);
    return versioned ? transaction.constructor.deserialize(bytes) : transaction.constructor.from(bytes);
  },
  on(event: string, handler: Handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(handler);
  },
  off(event: string, handler: Handler) { listeners.get(event)?.delete(handler); },
};

Object.defineProperty(window, "kakure", { value: provider, configurable: false, writable: false });
window.dispatchEvent(new Event("kakure#initialized"));
