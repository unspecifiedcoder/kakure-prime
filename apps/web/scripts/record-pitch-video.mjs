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

async function addFilmLayer() {
  await page.addStyleTag({ content: `
    #kakure-film-caption { position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%); width: min(1050px, calc(100vw - 80px)); box-sizing: border-box; padding: 16px 22px; border: 1px solid rgba(101,211,153,.65); border-radius: 8px; background: rgba(7,17,13,.94); color: #f1f7f3; font: 650 22px/1.35 Inter,system-ui,sans-serif; letter-spacing: -.01em; text-align: center; box-shadow: 0 20px 55px rgba(0,0,0,.38); }
    #kakure-film-mark { position: fixed; z-index: 2147483647; right: 22px; top: 18px; padding: 8px 11px; border-radius: 999px; background: #07110d; color: #65d399; font: 750 11px/1 ui-monospace,monospace; letter-spacing: .12em; box-shadow: 0 10px 30px rgba(0,0,0,.2); }
  ` });
  await page.evaluate(() => {
    document.querySelectorAll("#kakure-film-caption, #kakure-film-mark").forEach((node) => node.remove());
    const caption = document.createElement("div");
    caption.id = "kakure-film-caption";
    caption.setAttribute("role", "presentation");
    document.body.append(caption);
    const mark = document.createElement("div");
    mark.id = "kakure-film-mark";
    mark.textContent = "KAKURE PRIME · STOCKLANA";
    mark.setAttribute("role", "presentation");
    document.body.append(mark);
  });
}

async function caption(text, milliseconds) {
  await page.locator("#kakure-film-caption").evaluate((node, value) => { node.textContent = value; }, text);
  await page.waitForTimeout(milliseconds);
}

async function openKakure(hash) {
  await page.goto(`https://kakure-prime.vercel.app/?recording=final#${hash}`, { waitUntil: "domcontentloaded" });
  await addFilmLayer();
}

await openKakure("/");
await caption("Ordinary treasury wallets expose the strategy: positions, rebalances, recipients, and signer activity.", 6_500);
await page.getByText("What the chain sees").scrollIntoViewIfNeeded();
await caption("Kakure makes tokenized-equity settlement private — without making it unaccountable.", 6_000);

await openKakure("/wallet");
await page.getByLabel("Wallet passphrase").fill("Kakure-Final-Demo-2026!");
await page.getByLabel("Confirm passphrase").fill("Kakure-Final-Demo-2026!");
await caption("Kakure Wallet creates and encrypts a Solana signing key locally. The key never reaches Kakure services.", 6_000);
await page.getByRole("button", { name: "Create Kakure Wallet" }).click();
await page.getByText("SELF-CUSTODY ADDRESS").waitFor();
await caption("One self-custody wallet funds the shielded pool. Inside Kakure, positions become commitments and spends become nullifiers.", 7_000);
await page.getByLabel("Wallet network").selectOption("mainnet-beta");
await caption("Mainnet portfolio reads are supported; settlement is deliberately gated until audited programs are deployed.", 5_000);

await openKakure("/demo");
await page.getByText("04 · KAKURE PROTOCOL").waitFor();
await caption("The evidence rail is live: official PreStocks data, Pyth risk gates, Meteora DBC, and deployed Solana programs.", 6_000);
await page.locator("#demo-asset").selectOption("OPENAI");
await caption("Negative path one: OpenAI is outside its token-to-mark mandate. Settlement is blocked — fail closed.", 6_000);
await page.locator("#demo-lane").selectOption("aaplx");
await caption("Negative path two: missing or stale authenticated Pyth data is a hard stop, never an invented price.", 6_000);

await page.locator("#demo-lane").selectOption("prestocks");
await page.locator("#demo-asset").selectOption("ANTHROPIC");
await page.getByRole("button", { name: /Shield 42\.50 ANTHROPIC/ }).click();
await caption("An eligible Anthropic position becomes a zero-knowledge note controlled by a 3-of-5 FROST quorum.", 6_000);
await page.getByRole("button", { name: /Propose private distribution/ }).click();
await caption("The proposal is encrypted. Public observers cannot recover the asset, amount, recipient, or signer graph.", 6_000);
await page.getByRole("button", { name: /Collect 3 approvals/ }).click();
await caption("Three independent approvals reach quorum. No custodian and no shared private key.", 5_500);
await page.getByRole("button", { name: /Generate proof & settle/ }).click();
await page.getByText("Proof verified · settlement final").waitFor();
await caption("The chain receives only a commitment, a spent nullifier, and a valid Groth Sixteen proof.", 6_000);
await caption("Authorized signers retain operational detail; a separate auditor quorum enables accountable disclosure.", 5_500);

await page.goto("https://explorer.solana.com/tx/57ro5JMwkSZaMM15DjBrCXkUoxKtVvfRkJbYAVRHZzz6TKGdTivqKvDiLsGh22FroEBBbXrdQzjuRw6Cr368y1to?cluster=devnet", { waitUntil: "domcontentloaded", timeout: 30_000 });
await addFilmLayer();
await caption("Real devnet evidence: a finalized Meteora DBC trade and deployed Kakure programs, inspectable by anyone.", 8_000);

await openKakure("/");
await page.getByRole("heading", { name: "Your equity strategy should not be public alpha." }).scrollIntoViewIfNeeded();
await caption("Private operations. Threshold governance. Verifiable settlement. Accountable disclosure.", 6_000);
await caption("Kakure Prime — hide the strategy, not accountability.", 5_000);

await context.close();
await browser.close();

const [recording] = (await readdir(scratchDir)).filter((name) => name.endsWith(".webm"));
if (!recording) throw new Error("Playwright did not produce a pitch recording");
await rename(join(scratchDir, recording), join(outputDir, "kakure-prime-pitch-silent.webm"));
await rm(scratchDir, { recursive: true, force: true });
