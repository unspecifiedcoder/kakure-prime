import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extension = resolve(import.meta.dirname, "../dist");
const profile = await mkdtemp(join(tmpdir(), "kakure-extension-"));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  ...(executablePath ? { executablePath } : {}),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

try {
  let workers = context.serviceWorkers();
  if (!workers.length) workers = [await context.waitForEvent("serviceworker", { timeout: 15_000 })];
  const extensionId = new URL(workers[0].url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByText("Public outside.").waitFor();
  await page.locator("#create-passphrase").fill("Kakure-Extension-Smoke-2026!");
  await page.locator("#confirm-passphrase").fill("Kakure-Extension-Smoke-2026!");
  await page.getByRole("button", { name: /Create Kakure Wallet/ }).click();
  await page.getByText("SELF-CUSTODY ADDRESS").waitFor();
  const site = await context.newPage();
  await site.goto("https://example.com");
  await site.waitForFunction(() => window.kakure?.isKakure === true);
  const connected = await site.evaluate(() => window.kakure.connect().then((result) => result.publicKey.toBase58()));
  const approvalWindow = context.waitForEvent("page");
  const signature = site.evaluate(() => window.kakure.signMessage(new TextEncoder().encode("kakure-extension-smoke")).then((result) => [...result.signature]));
  const approval = await approvalWindow;
  await approval.getByRole("button", { name: /Approve & sign/ }).click();
  if ((await signature).length !== 64) throw new Error("Kakure Wallet returned an invalid Ed25519 signature length.");
  console.log(`Kakure Wallet loaded, created a vault, injected its provider, connected ${connected}, and approved a signature (${extensionId}).`);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
