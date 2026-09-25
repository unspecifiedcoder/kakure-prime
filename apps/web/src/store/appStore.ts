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

function defaultSettings(): Settings {
  return {
    rpcUrl: "http://127.0.0.1:8899",
    indexerUrl: "http://127.0.0.1:8788",
    coordinatorUrl: "http://127.0.0.1:8789",
    helperUrl: "http://127.0.0.1:8787",
    helperToken: "",
    programId: "",
  };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) };
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
