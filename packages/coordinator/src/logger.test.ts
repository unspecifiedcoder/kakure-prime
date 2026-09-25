import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

const HEX32 = /[0-9a-fA-F]{64}/;
// ISO 8601 timestamp or a plausible epoch-ms integer (13 digits, current era).
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;
const EPOCH_MS = /\b1\d{12}\b/;

describe("privacy-safe logger", () => {
  it("never emits a session id and a timestamp on the same line across a simulated request flow", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    const sessionId = "a".repeat(64);

    // Simulate a full request flow: append, longpoll wait/resolve, ws connect/disconnect, sweep.
    logger.logSession("session.append", sessionId);
    logger.logTiming("request.duration", 12);
    logger.logSession("session.longpoll_start", sessionId);
    logger.logTiming("request.duration", 25000);
    logger.logSession("session.longpoll_resolve", sessionId);
    logger.logSession("session.ws_connect", sessionId);
    logger.logSession("session.ws_disconnect", sessionId);
    logger.logTiming("sweep.duration", 3);
    logger.logTiming("sweep.rows_removed", 42);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const hasSessionId = HEX32.test(line);
      const hasTimestamp = ISO_TIMESTAMP.test(line) || EPOCH_MS.test(line);
      expect(hasSessionId && hasTimestamp).toBe(false);
    }

    // Sanity: the assertions above aren't vacuous — both kinds of line actually occur.
    expect(lines.some((l) => HEX32.test(l))).toBe(true);
    expect(lines.some((l) => ISO_TIMESTAMP.test(l))).toBe(true);
  });

  it("logSession's own output never contains a timestamp field, by construction", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.logSession("session.append", "b".repeat(64));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ event: "session.append", session_id: "b".repeat(64) });
  });

  it("logTiming's own output never contains a session id field, by construction", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.logTiming("request.duration", 7);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed["session_id"]).toBeUndefined();
    expect(typeof parsed["timestamp"]).toBe("string");
  });
});
