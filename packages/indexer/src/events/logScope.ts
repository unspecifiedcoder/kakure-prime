/**
 * Scopes a transaction's flat `logMessages` array down to the `"Program data: "` lines emitted
 * WHILE `programId` was the currently-executing program, using Solana's own log bracketing
 * (`"Program <id> invoke [<depth>]"` / `"Program <id> success"` / `"Program <id> failed: ..."`).
 *
 * This matters because `sol_log_data`'s own log line carries no program id -- unlike an
 * `emit_cpi!` self-CPI (an actual instruction, filterable by `programId`), a `"Program data: "`
 * line is indistinguishable from one emitted by an unrelated CPI'd program (or, in principle, by
 * a same-transaction invocation of `kakure_pool` nested inside another program) without walking
 * the invoke/success stack the runtime itself prints.
 */
const INVOKE_RE = /^Program (\S+) invoke \[\d+\]$/;
const END_RE = /^Program (\S+) (success|failed)/;

export function programDataLinesFor(logMessages: readonly string[], programId: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of logMessages) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    const end = END_RE.exec(line);
    if (end) {
      const idx = stack.lastIndexOf(end[1]!);
      if (idx !== -1) stack.length = idx;
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      out.push(line);
    }
  }
  return out;
}
