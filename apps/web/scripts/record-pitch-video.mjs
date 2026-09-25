import { chromium } from "@playwright/test";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const outputDir = resolve("public", "videos");
const scratchDir = resolve(".pitch-video-output");
await mkdir(outputDir, { recursive: true });
await rm(scratchDir, { recursive: true, force: true });
await mkdir(scratchDir, { recursive: true });

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: scratchDir, size: { width: 1280, height: 720 } },
  colorScheme: "light",
});
const page = await context.newPage();

await page.goto("https://kakure-prime.vercel.app/?recording=pitch#/demo", { waitUntil: "networkidle" });
await page.getByText("04 · KAKURE PROTOCOL").waitFor();
await page.waitForTimeout(20_000);

await page.locator("#demo-asset").selectOption("OPENAI");
await page.waitForTimeout(13_000);
await page.locator("#demo-lane").selectOption("aaplx");
await page.waitForTimeout(12_000);
await page.locator("#demo-lane").selectOption("prestocks");
await page.locator("#demo-asset").selectOption("ANTHROPIC");
await page.waitForTimeout(4_000);

for (const label of [
  /Shield 42\.50 ANTHROPIC/,
  /Propose private distribution/,
  /Collect 3 approvals/,
  /Generate proof & settle/,
]) {
  await page.getByRole("button", { name: label }).click();
  await page.waitForTimeout(6_000);
}

await page.getByText("Proof verified · settlement final").scrollIntoViewIfNeeded();
await page.waitForTimeout(8_000);
await context.close();
await browser.close();

const [recording] = (await readdir(scratchDir)).filter((name) => name.endsWith(".webm"));
if (!recording) throw new Error("Playwright did not produce a pitch recording");
await rename(join(scratchDir, recording), join(outputDir, "kakure-prime-pitch-silent.webm"));
await rm(scratchDir, { recursive: true, force: true });
