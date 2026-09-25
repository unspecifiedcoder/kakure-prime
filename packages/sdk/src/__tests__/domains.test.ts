import { describe, it, expect } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3";
import { ENC_DOMAIN, PSI_DOMAIN } from "../crypto/constants.js";
import { stringToFr } from "../crypto/fields.js";

const P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const keccak256Utf8 = (label: string): bigint =>
  BigInt("0x" + Buffer.from(keccak_256(new TextEncoder().encode(label))).toString("hex"));
const domainOf = (label: string): bigint => keccak256Utf8(label) % P;

describe("note-format domain tags (parity)", () => {
  it("match keccak256(label) % BN254_Fr", () => {
    expect(ENC_DOMAIN).toBe(domainOf("kakure.enc.v1"));
    expect(PSI_DOMAIN).toBe(domainOf("kakure.psi.v1"));
  });

  it("are pairwise distinct", () => {
    expect(ENC_DOMAIN).not.toBe(PSI_DOMAIN);
  });

  it("KAT: exact field values match the Noir ENC_DOMAIN/PSI_DOMAIN globals", () => {
    // regenerated for kakure.* domains
    expect(ENC_DOMAIN).toBe(
      0x23f955e41a1c10e85986f4fb49fcaf4cb8a6d3264f10fd0253d5e212303b9882n,
    );
    expect(PSI_DOMAIN).toBe(
      0x20b80b02c7b72d50c3f3dbdb4aa38592cdac5c1aa0f9d3f3509480ae234a790n,
    );
  });

  it("KDF purpose-labels derive distinct field tags (key domain separation)", async () => {
    const labels = [
      "kakure.mnemonic",
      "kakure.root",
      "kakure.view",
      "kakure.inKey",
      "kakure.pubIn",
      "kakure.selfEph",
      "kakure.selfSpend",
      "kakure.msInKey",
      "kakure.msSelfEph",
    ];
    const frs = await Promise.all(labels.map((l) => stringToFr(l)));
    const distinct = new Set(frs.map((f) => f.toString()));
    expect(distinct.size).toBe(labels.length);
  });
});
