// Playwright driver for the browser-proving measurement (task step 3): loads
// the bench page (served by `vite preview`) in headless Chromium, runs
// `__kakureRunBench(circuit)` in-page, and prints a JSON report per circuit.
// Usage: node run.mjs <baseUrl> <circuit...>
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import os from "node:os";

const [baseUrl, ...circuits] = process.argv.slice(2);
if (!baseUrl || circuits.length === 0) {
  console.error("usage: node run.mjs <baseUrl> <circuit...>");
  process.exit(1);
}

// This machine is shared with other agents' work -- record host load so the
// numbers below can be read in context (a loaded 4-core box makes wasm's
// single-threaded prove step relatively worse, since it can't compete for
// cores the way native gnark's parallel FFT/MSM does).
const hostStatsAt = () => ({
  loadavg: os.loadavg(),
  freeMemMB: +(os.freemem() / 1e6).toFixed(1),
  totalMemMB: +(os.totalmem() / 1e6).toFixed(1),
});

const browser = await chromium.launch({
  headless: true,
  args: ["--js-flags=--max-old-space-size=4096"],
});

const results = [];
for (const circuit of circuits) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[page:${circuit}] ${msg.text()}`));
  page.on("pageerror", (err) => console.error(`[page:${circuit}] ERROR`, err));

  console.log(`--- navigating for ${circuit} ---`);
  await page.goto(baseUrl, { waitUntil: "load" });

  console.log(`--- proving ${circuit} in Chromium (this can take a while) ---`);
  const hostBefore = hostStatsAt();
  const t0 = Date.now();
  const result = await page.evaluate(async (c) => await window.__kakureRunBench(c), circuit);
  const wallMs = Date.now() - t0;
  const hostAfter = hostStatsAt();
  result.wallMsFromNode = wallMs;
  result.hostBefore = hostBefore;
  result.hostAfter = hostAfter;

  console.log(`--- ${circuit} done in ${wallMs}ms (page-reported proveMs=${result.proveMs}) ---`);
  results.push(result);

  // Persist raw proof/pw for a `sunspot verify` cross-check outside the browser.
  writeFileSync(`./${circuit}.chromium.proof`, Buffer.from(result.proofB64, "base64"));
  writeFileSync(`./${circuit}.chromium.pw`, Buffer.from(result.pwB64, "base64"));
  delete result.proofB64;
  delete result.pwB64;

  await context.close();
}

await browser.close();

console.log("\n=== RESULTS ===");
console.log(JSON.stringify(results, null, 2));
writeFileSync("./bench-results.json", JSON.stringify(results, null, 2));
