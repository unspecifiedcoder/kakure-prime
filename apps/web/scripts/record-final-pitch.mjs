import { chromium } from "@playwright/test";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = process.env.KAKURE_VIDEO_BASE_URL ?? "http://127.0.0.1:4173";
const outputDir = resolve("public", "videos");
const scratchDir = resolve(".final-pitch-output");
await mkdir(outputDir, { recursive: true });
await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: scratchDir, size: { width: 1280, height: 720 } },
  colorScheme: "dark",
});
const page = await context.newPage();

async function pause(milliseconds) {
  await page.waitForTimeout(milliseconds);
}
async function open(hash) {
  await page.goto(`${baseUrl}/?recording=final#${hash}`, { waitUntil: "networkidle" });
}
async function center(selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
}

await open("/");
await page.getByRole("heading", { name: "Your equity strategy should not be public alpha." }).waitFor();
await pause(5_000);
await center(".devnet-proof-rail");
await pause(5_000);

await open("/evidence");
await page.getByRole("heading", { name: /The transfer finalized/ }).waitFor();
await pause(7_000);
await center(".evidence-flow");
await pause(12_000);
await center(".evidence-rejections");
await pause(5_000);
await center(".evidence-programs");
await pause(6_000);

await open("/demo");
await page.getByText("00 · PUBLIC DEVNET E2E").waitFor();
await center(".integration-evidence");
await pause(9_000);
await center(".demo-workspace");
await pause(3_000);

for (const [label, delay] of [
  [/Shield 42\.50/, 3_000],
  [/Propose private distribution/, 3_000],
  [/Collect 3 approvals/, 3_000],
  [/Generate proof & settle/, 5_000],
]) {
  await page.getByRole("button", { name: label }).click();
  await pause(delay);
}

await center(".demo-visibility");
await pause(7_000);
await open("/");
await center(".devnet-proof-rail");
await pause(7_000);

const video = page.video();
await context.close();
if (!video) throw new Error("Playwright did not create the pitch recording");
const recording = await video.path();
await copyFile(recording, resolve(outputDir, "kakure-prime-final-silent.webm"));
await browser.close();
await rm(scratchDir, { recursive: true, force: true });
