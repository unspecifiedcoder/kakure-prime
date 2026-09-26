#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_PUBLIC_KEYPAIRS = new Set([
  "programs/deploy/kakure_pool-keypair.json",
  "programs/deploy/mock_verifier-keypair.json",
]);

const signatures = [
  ["Vercel token", /\bvcp_[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private-key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
];

const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "Unable to enumerate tracked files.\n");
  process.exit(listed.status ?? 1);
}

const findings = [];
for (const path of listed.stdout.split("\0").filter(Boolean)) {
  const normalized = path.replaceAll("\\", "/");

  if (/keypair\.json$/i.test(normalized) && !ALLOWED_PUBLIC_KEYPAIRS.has(normalized)) {
    findings.push(`${normalized}: unapproved tracked Solana keypair`);
  }

  let size;
  try {
    size = statSync(path).size;
  } catch {
    continue;
  }
  if (size > MAX_TEXT_FILE_BYTES) continue;

  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");

  for (const [label, pattern] of signatures) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push(`${normalized}:${line}: possible ${label}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed secrets detected:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  console.error("\nRemove and rotate real credentials. Extend the allowlist only for intentionally public fixtures.");
  process.exit(1);
}

console.log("Secret scan passed: no known credential signatures in tracked files.");
