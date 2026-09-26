import { create } from "zustand";
import type { PublicKey } from "@solana/web3.js";
import type { SolanaAccount } from "@kakure/sdk";

export interface TreasurySummary {
  id: string;
  name: string;
  threshold: number;
  signerCount: number;
}

export interface Settings {
  rpcUrl: string;
  indexerUrl: string;
  coordinatorUrl: string;
  helperUrl: string;
  /** Per-launch secret from the helper's startup output: kept in memory only, never persisted. */
  helperToken: string;
  /** The pool program to pay from. Empty until set: every chain action refuses with a clear message. */
  programId: string;
}

const SETTINGS_KEY = "kakure.web.settings.v1";
const DEVNET_PROGRAM_ID = "HPzs68TncDWTHocTZv5ekvpMwDjcx4PeHLoTedwBsccF";

function defaultSettings(): Settings {
  return {
    rpcUrl: "https://api.devnet.solana.com",
    indexerUrl: "https://kakure-prime-indexer.fly.dev",
    coordinatorUrl: "https://kakure-prime-coordinator.fly.dev",
    helperUrl: "http://127.0.0.1:8787",
    helperToken: "",
    programId: DEVNET_PROGRAM_ID,
  };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const saved = JSON.parse(raw) as Partial<Settings>;
    // Migrate the pre-hosted demo defaults without overriding endpoints a user deliberately set.
    if (saved.rpcUrl === "http://127.0.0.1:8899") saved.rpcUrl = "https://api.devnet.solana.com";
    if (saved.indexerUrl === "http://127.0.0.1:8788") saved.indexerUrl = "https://kakure-prime-indexer.fly.dev";
    if (saved.coordinatorUrl === "http://127.0.0.1:8789") saved.coordinatorUrl = "https://kakure-prime-coordinator.fly.dev";
    if (!saved.programId) saved.programId = DEVNET_PROGRAM_ID;
    return { ...defaultSettings(), ...saved };
  } catch {
    return defaultSettings();
  }
}

interface AppState {
  // Wallet/session: kept in memory only, never persisted (spec §4: spend keys never leave the
  // browser at rest, and a page refresh should not silently keep a derived account resident).
  walletPublicKey: PublicKey | null;
  account: SolanaAccount | null;
  connect(publicKey: PublicKey, account: SolanaAccount): void;
  disconnect(): void;

  // Non-secret prefs, persisted to localStorage per spec §2.
  settings: Settings;
  updateSettings(patch: Partial<Settings>): void;

  // Non-secret treasury metadata (ids/names/threshold) -- the group's actual secret material lives
  // encrypted in IndexedDB (src/lib/keystore.ts), keyed by these same ids.
  treasuries: TreasurySummary[];
  addTreasury(t: TreasurySummary): void;
  removeTreasury(id: string): void;
}

export const useAppStore = create<AppState>((set) => ({
  walletPublicKey: null,
  account: null,
  connect: (publicKey, account) => set({ walletPublicKey: publicKey, account }),
  disconnect: () => set({ walletPublicKey: null, account: null }),

  settings: loadSettings(),
  updateSettings: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      try {
        const { helperToken: _secret, ...persisted } = next;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(persisted));
      } catch {
        // best-effort; a private/incognito context may reject writes
      }
      return { settings: next };
    }),

  treasuries: [],
  addTreasury: (t) => set((state) => ({ treasuries: [...state.treasuries, t] })),
  removeTreasury: (id) => set((state) => ({ treasuries: state.treasuries.filter((t) => t.id !== id) })),
}));
