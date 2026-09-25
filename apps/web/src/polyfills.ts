// Node-global polyfills for the browser bundle. This module MUST be the first import of the entry
// point: ES module imports are evaluated before the importing module's body, so assigning
// `globalThis.Buffer` inside `main.tsx` runs too late for dependencies that touch `Buffer` at module
// top level (`@kakure/cli`, `@solana/web3.js`). A separate module imported first evaluates first.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string | undefined> } };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.process) g.process = { env: {} };
