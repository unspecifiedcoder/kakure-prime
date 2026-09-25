/**
 * Privacy-safe logger for the coordinator (spec §5 "Coordinator privacy contract" / master plan's
 * global constraint: never log `(session_id, timestamp)` together).
 *
 * The two log functions are disjoint by *signature*, not by convention: `logSession` has no
 * parameter through which a timestamp could be attached, and `logTiming` has no parameter through
 * which a session id could be attached. There is no call that produces a single log line
 * containing both — the type system rules it out.
 *
 * slice-2 F-8 CAVEAT: this guarantee holds for the LINE CONTENT `createLogger` produces, but
 * `defaultSink` writes plain lines to stdout -- journald, Docker, and every hosted log pipeline
 * stamp EVERY line they receive with a timestamp regardless of what's inside it, so a
 * `session.*` line still ends up paired with a timestamp in the operator's actual logs once it
 * leaves this process. Getting the full guarantee requires either: (a) a `LogSink` that discards
 * `session.*` events entirely (count them via `logTiming` instead, e.g. `session.append_count`),
 * or (b) a deployment that genuinely does not record time-of-arrival for stdout lines (rare in
 * practice). Neither is done here by default -- pick (a) via a custom sink if `session.*`
 * visibility in ordinary hosted logs turns out to matter for a given deployment.
 */

export type LogSink = (line: string) => void;

export type SessionLogEvent =
  | "session.append"
  | "session.read"
  | "session.ws_connect"
  | "session.ws_disconnect"
  | "session.longpoll_start"
  | "session.longpoll_resolve"
  | "session.longpoll_timeout"
  | "session.sequence_conflict";

export type TimingLogEvent = "request.duration" | "sweep.duration" | "sweep.rows_removed";

export interface Logger {
  /** Logs an event tied to a session id. Never includes a timestamp. */
  logSession(event: SessionLogEvent, sessionId: string): void;
  /** Logs an event tied to a duration/count. Never includes a session id. */
  logTiming(event: TimingLogEvent, value: number): void;
}

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}

export function createLogger(sink: LogSink = defaultSink): Logger {
  return {
    logSession(event, sessionId) {
      sink(JSON.stringify({ event, session_id: sessionId }));
    },
    logTiming(event, value) {
      sink(JSON.stringify({ event, value, timestamp: new Date().toISOString() }));
    },
  };
}
