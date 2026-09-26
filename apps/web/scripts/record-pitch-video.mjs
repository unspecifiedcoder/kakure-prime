import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const outputDir = resolve("public", "videos");
const scratchDir = resolve(".pitch-video-output");
const extensionDir = resolve("../wallet-extension/dist");
const fundingKeypairPath = process.env.KAKURE_VIDEO_FUNDER_KEYPAIR;
if (!fundingKeypairPath) throw new Error("Set KAKURE_VIDEO_FUNDER_KEYPAIR to a funded Devnet keypair file.");
const profileDir = await mkdtemp(join(tmpdir(), "kakure-video-profile-"));
await mkdir(outputDir, { recursive: true });
await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: scratchDir, size: { width: 1280, height: 720 } },
  colorScheme: "dark",
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

let workers = context.serviceWorkers();
if (!workers.length) workers = [await context.waitForEvent("serviceworker", { timeout: 15_000 })];
const extensionId = new URL(workers[0].url()).host;
const page = await context.newPage();
let transferExplorer = "";

async function pause(milliseconds) { await page.waitForTimeout(milliseconds); }
async function frameExtension() {
  await page.addStyleTag({ content: "html{min-height:100%;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#163326,#020604 70%)}body{width:382px;min-width:382px;min-height:620px;box-shadow:0 35px 100px #000;border-radius:18px;overflow:hidden}" });
}
async function openApp(hash) {
  await page.goto(`http://127.0.0.1:4173/?recording=final#${hash}`, { waitUntil: "domcontentloaded" });
}

await page.goto(`chrome-extension://${extensionId}/popup.html`);
await frameExtension();
await pause(4_500);
await page.locator("#create-passphrase").fill("Kakure-Video-Extension-2026!");
await page.locator("#confirm-passphrase").fill("Kakure-Video-Extension-2026!");
await pause(3_000);
await page.getByRole("button", { name: /Create Kakure Wallet/ }).click();
await page.getByText("SELF-CUSTODY ADDRESS").waitFor();
await pause(4_000);
const walletStatus = await page.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
const walletAddress = walletStatus.result.address;
const fundingKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  readFileSync(fundingKeypairPath, "utf8"),
)));
const fundingConnection = new Connection("https://api.devnet.solana.com", "confirmed");
await sendAndConfirmTransaction(
  fundingConnection,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: fundingKeypair.publicKey,
    toPubkey: new PublicKey(walletAddress),
    lamports: 0.1 * LAMPORTS_PER_SOL,
  })),
  [fundingKeypair],
  { commitment: "confirmed" },
);
await page.reload();
await frameExtension();
await page.getByText("SELF-CUSTODY ADDRESS").waitFor();
await pause(3_000);
await page.getByRole("button", { name: /Send SOL/ }).click();
await page.locator("#recipient").fill("Dt3NcAkrUhhLSjQ6TL17t58djpyfayKdgBy9xd1wjVDY");
await page.locator("#amount").fill("0.01");
await page.getByRole("button", { name: /Review transfer/ }).click();
await pause(4_000);
await page.getByRole("button", { name: /Confirm & send/ }).click();
try {
  await page.getByText("Submitted to Solana.").waitFor({ timeout: 45_000 });
} catch (error) {
  throw new Error(`Wallet transfer failed: ${await page.locator("#message").textContent()}`, { cause: error });
}
transferExplorer = await page.locator("#explorer-link").getAttribute("href") ?? "";
await pause(6_000);

await openApp("/wallet");
await page.getByRole("heading", { name: /Your Solana wallet/ }).waitFor();
await pause(8_000);

await openApp("/");
await page.getByRole("heading", { name: "Your equity strategy should not be public alpha." }).waitFor();
await pause(5_000);
const approvalWindowPromise = context.waitForEvent("page");
await page.getByRole("button", { name: "Connect wallet" }).first().click();
const approvalWindow = await approvalWindowPromise;
await approvalWindow.waitForLoadState("domcontentloaded");
const approvalUrl = approvalWindow.url();
await page.goto(approvalUrl);
await frameExtension();
await page.getByText("Approve only what you understand.").waitFor();
await pause(7_000);
await approvalWindow.close();

await page.goto("https://kakure-prime.vercel.app/?recording=final#/demo", { waitUntil: "domcontentloaded" });
await page.getByText("04 · KAKURE PROTOCOL").waitFor();
await pause(5_000);
await page.locator("#demo-asset").selectOption("OPENAI");
await pause(5_000);
await page.locator("#demo-lane").selectOption("aaplx");
await pause(5_000);
await page.locator("#demo-lane").selectOption("prestocks");
await page.locator("#demo-asset").selectOption("ANTHROPIC");

for (const [label, delay] of [
  [/Shield 42\.50 ANTHROPIC/, 4_000],
  [/Propose private distribution/, 4_000],
  [/Collect 3 approvals/, 4_000],
  [/Generate proof & settle/, 6_000],
]) {
  await page.getByRole("button", { name: label }).click();
  await pause(delay);
}

await page.goto(transferExplorer, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.getByText("Finalized (MAX Confirmations)").waitFor({ timeout: 30_000 });
await pause(7_000);

await openApp("/");
await page.getByRole("heading", { name: "Your equity strategy should not be public alpha." }).waitFor();
await pause(6_000);

const video = page.video();
await context.close();
if (!video) throw new Error("Playwright did not create the pitch recording");
const recording = await video.path();
await rename(recording, join(outputDir, "kakure-prime-pitch-silent.webm"));
await rm(scratchDir, { recursive: true, force: true });
await rm(profileDir, { recursive: true, force: true });
