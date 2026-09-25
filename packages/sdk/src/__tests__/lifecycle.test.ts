import { describe, it, expect } from "vitest";
import { Fr } from "@aztec/foundation/fields";
import { Point } from "@zk-kit/baby-jubjub";
import { SolanaAccount } from "../keys/SolanaAccount";
import { KeyRepository } from "../state/KeyRepository";
import { InMemoryEphemeralCounterStore } from "../state/EphemeralCounterStore";
import { NoteProcessor } from "../sync/NoteProcessor";
import { UnprocessedEvent } from "../sync/types";
import {
  IKeyRepository,
  IncomingAddress,
  KeyRepoState,
  SelfEphemeral,
} from "../repositories";
import { deriveCek, unwrapCek, wrapCek } from "../crypto/kem";
import { demEncrypt } from "../crypto/dem";
import { computePsi } from "../note/nullifier";
import { leaf as computeLeaf } from "../note/note";
import { publicKey, pubkeyOwner, discoveryTag } from "../note/keys";

const MNEMONIC = "test test test test test test test test test test test junk";

const COMPLIANCE_PK: Point<bigint> = [
  0x085ed469c9a9f102b6d4f6f909b8ceaf6ca49b39759ac2e0feb7e0aada8b7111n,
  0x245e25ab2bd42f0280a5ade750828dd6868f5225ae798d6b51c676f519c8f4e8n,
];

class FixtureKeyRepo implements IKeyRepository {
  readonly selfScanIndex = 0;
  readonly incomingScanIndex = 0;

  constructor(
    private readonly selfTags: Map<string, { eph: Fr; index: number }>,
    private readonly incomingTags: Map<string, { inKey: Fr; index: number }>,
    private readonly selfSpend: Fr,
    private readonly selfSpendPub: Point<bigint>,
  ) {}

  public matchSelfTag(tag: bigint | string): { eph: Fr; index: number } | null {
    return this.selfTags.get(new Fr(BigInt(tag)).toString()) ?? null;
  }

  public matchIncomingTag(
    tag: bigint | string,
  ): { inKey: Fr; index: number } | null {
    return this.incomingTags.get(new Fr(BigInt(tag)).toString()) ?? null;
  }

  public async getSelfSpendScalar(): Promise<Fr> {
    return this.selfSpend;
  }
  public async getSelfSpendPub(): Promise<Point<bigint>> {
    return this.selfSpendPub;
  }

  public recordIncomingMatch(): void {}
  public async ensureSelfLookahead(): Promise<boolean> {
    return false;
  }
  public async ensureIncomingLookahead(): Promise<boolean> {
    return false;
  }
  public nextSelfEphemeral(): Promise<SelfEphemeral> {
    return Promise.reject(new Error("FixtureKeyRepo does not mint"));
  }
  public nextIncomingAddress(): Promise<IncomingAddress> {
    return Promise.reject(new Error("FixtureKeyRepo does not issue"));
  }
  public getState(): KeyRepoState {
    throw new Error("FixtureKeyRepo is not durable");
  }
  public async restore(): Promise<void> {}
}

describe("self-note lifecycle (deposit fixture round-trip)", () => {
  const DEPOSIT_TAG =
    0x1961ff2315812fd2f3e459a258f5ded2dde68cd35c79c8b9fb443e1860e1fbe4n;
  // regenerated for kakure.* domains: same CEK/owner/plaintext, re-derived psi/leaf/nullifier and
  // re-encrypted ciphertext under the new ENC_DOMAIN/PSI_DOMAIN.
  const DEPOSIT_LEAF =
    "0x3056dd556d5cdd64264d91742bc7d8ee1af96c53e799c99244a2674498ba3f30";
  const DEPOSIT_CEK = new Fr(
    0x0f55e80a890924a14c58cae89e59608fb8bb124578d548643e81fdaaa6c833f6n,
  );
  const OWNER_SELF = new Fr(
    0x2874ae964d8b283e2f521a7f14125fc92747bb9770139b8d4b70ee09e2d83785n,
  );
  const NULLIFIER_AT_0 = new Fr(
    0x1b5a2970d07fa6183eed9bb0ab0fd7bec3e1681050e3f61f449e1ecdf96dddd9n,
  );
  const SELF_SPEND = new Fr(789n);
  const DEPOSIT_CT = [
    "0x1b0ceb33cd98b842d3c9097c95301b1d91e418e02f420573cfb11a3e7267e750",
    "0x09fb320645ae9ec92ef9c4391635afca701aa3e54fa3495cb256a096d6485dab",
    "0x28de5b6c76b4d66926c4488cbdf757568c47fc40f6f5a2cd05c2e1d14fa73b00",
    "0x1fc49c7d9ddbd3cecb5c333c8eb16ed7041a96e8dc4404ebcc6cb459efb4725a",
    "0x1757618c9883e2bc3de0c4b27be4d6932d6a18cd13ac225c192c75437d2ac840",
    "0x086af9eaa963ce91d18b4b20d95da6f71e801fb626f7435944995d9bb43cd464",
    "0x1b8001776d6f0ca9600974dc54cff4e1246fdfe333bbd1ad5419f0abe9603b81",
  ];

  it("CEK = (eph*C).x reproduces the fixture content key", () => {
    expect(deriveCek(new Fr(5n), COMPLIANCE_PK).equals(DEPOSIT_CEK)).toBe(true);
  });

  it("decrypts the deposit ciphertext to value 100 / owner_self / fixture leaf and nullifier at index 0", async () => {
    const selfTags = new Map([
      [new Fr(DEPOSIT_TAG).toString(), { eph: new Fr(5n), index: 0 }],
    ]);
    const repo = new FixtureKeyRepo(
      selfTags,
      new Map(),
      SELF_SPEND,
      publicKey(SELF_SPEND),
    );
    const processor = new NoteProcessor(repo, COMPLIANCE_PK);

    const event: UnprocessedEvent = {
      type: "NEW_NOTE",
      blockNumber: 1,
      txHash: "0x00",
      args: {
        leafIndex: 0n,
        commitment: DEPOSIT_LEAF,
        ephemeralX: DEPOSIT_TAG,
        packedCiphertext: DEPOSIT_CT,
      },
    };

    const walletNote = await processor.process(event);
    expect(walletNote).not.toBeNull();
    expect(walletNote!.commitment.equals(new Fr(BigInt(DEPOSIT_LEAF)))).toBe(
      true,
    );
    expect(walletNote!.note.value).toBe(100n);
    expect(walletNote!.note.owner.equals(OWNER_SELF)).toBe(true);
    expect(walletNote!.nullifier.equals(NULLIFIER_AT_0)).toBe(true);
    expect(walletNote!.spendScalar.equals(SELF_SPEND)).toBe(true);
    expect(walletNote!.isIncoming).toBe(false);
  });
});

describe("incoming-memo lifecycle (transfer memo fixture round-trip)", () => {
  const MEMO_TAG =
    0x1b16e357953d68d73398c838aa883cc65ddae2aef75a4bc437e4232afdbe43c8n;
  const MEMO_EPH_X =
    0x0d2c8ddcfdd735e9fdd0d51538022ba533cfa83b81d2acec70b17f505c17f048n;
  const MEMO_EPH_Y =
    0x0de8d63022d65a455c438aacda47f8bc4141566562eb1cab57e5085b62a5a75en;
  // regenerated for kakure.* domains: same CEK/cek_wrap/owner/plaintext, re-derived psi/leaf and
  // re-encrypted ciphertext under the new ENC_DOMAIN/PSI_DOMAIN.
  const MEMO_LEAF =
    "0x2afb4f594a8f30963534a0ead6f4cf228721ed6334cd573976f1cd4639609968";
  const MEMO_CEK = new Fr(
    0x1c656035636eab11b0e052ddb751154c610872bf191c4f737b5365f6f473f153n,
  );
  const MEMO_CEK_WRAP =
    0x1c26e418b18e2072f8862447c7abbff3cc888b9bef1976bf14d7cf6910a926a0n;
  const OWNER_MEMO = new Fr(
    0x1113074e2fb269d979ad2b64e6fe70b1967c67b007b706600603b847306aefe3n,
  );
  const IN_KEY_J = new Fr(4n);
  const MEMO_CT = [
    "0x00cafd3cf85dd00ee3a4a75c2503b312804ee7e6b926ef6896cc7898f469785e",
    "0x26956ef8d68eedc13e07bf2aca916c15e3873566fe71aca1abc6f379ae6e9064",
    "0x1ff3d8c875652274a5b6512f402e9dc24e4bb090c9ea92f1572983ded5f57b34",
    "0x0862cd9fe4fb1fe62bb557efd92cfcfbe64df60e9b037ba633d70252053151e5",
    "0x2919e6e9a0067da0e3961f0372db0774dbffda9d6f17717778d2e596fc53547f",
    "0x110efae3d394f359445843cf2af1674fc1009f58a71c1c1c14b70174d06dddec",
    "0x0da3f87c8bbc03f8d4672688be6b01a5b7bb25d05dc9ae76d0680cdc12589903",
  ];

  it("unwrapCek recovers the fixture CEK from in_key_j and eph_pub", async () => {
    const recovered = await unwrapCek(new Fr(MEMO_CEK_WRAP), IN_KEY_J, [
      MEMO_EPH_X,
      MEMO_EPH_Y,
    ]);
    expect(recovered.equals(MEMO_CEK)).toBe(true);
  });

  it("decrypts the transfer memo to value 40 / owner_memo / fixture leaf as an incoming note", async () => {
    const incomingTags = new Map([
      [new Fr(MEMO_TAG).toString(), { inKey: IN_KEY_J, index: 0 }],
    ]);
    const repo = new FixtureKeyRepo(
      new Map(),
      incomingTags,
      new Fr(0n),
      publicKey(new Fr(1n)),
    );
    const processor = new NoteProcessor(repo, COMPLIANCE_PK);

    const event: UnprocessedEvent = {
      type: "NEW_MEMO",
      blockNumber: 1,
      txHash: "0x00",
      args: {
        leafIndex: 0n,
        commitment: MEMO_LEAF,
        ephemeralX: MEMO_EPH_X,
        packedCiphertext: MEMO_CT,
        tag: MEMO_TAG,
        cekWrap: MEMO_CEK_WRAP,
      },
    };

    const walletNote = await processor.process(event);
    expect(walletNote).not.toBeNull();
    expect(walletNote!.commitment.equals(new Fr(BigInt(MEMO_LEAF)))).toBe(true);
    expect(walletNote!.note.value).toBe(40n);
    expect(walletNote!.note.owner.equals(OWNER_MEMO)).toBe(true);
    expect(walletNote!.spendScalar.equals(IN_KEY_J)).toBe(true);
    expect(walletNote!.isIncoming).toBe(true);
  });
});

describe("WN-1: incoming note owner binding (phantom-note guard)", () => {
  const EPH = new Fr(8n);
  const IN_KEY = new Fr(4n);
  const ASSET = new Fr(0x1234n);
  const V1 = new Fr(1n);
  const ZERO = new Fr(0n);
  const hex = (f: Fr) => "0x" + f.toBigInt().toString(16).padStart(64, "0");

  async function memoEventFor(owner: Fr): Promise<UnprocessedEvent> {
    const inPub = publicKey(IN_KEY);
    const cek = deriveCek(EPH, COMPLIANCE_PK);
    const psi = await computePsi(cek);
    const commitment = await computeLeaf({
      noteVersion: V1,
      assetId: ASSET,
      noteType: ZERO,
      conditionsHash: ZERO,
      value: 40n,
      owner,
      psi,
      parents: ZERO,
    });
    const ct = await demEncrypt(cek, [
      V1,
      ASSET,
      ZERO,
      ZERO,
      new Fr(40n),
      owner,
      ZERO,
    ]);
    const cekWrap = await wrapCek(cek, EPH, inPub);
    const ephPub = publicKey(EPH);
    return {
      type: "NEW_MEMO",
      blockNumber: 1,
      txHash: "0x00",
      args: {
        leafIndex: 0n,
        commitment: hex(commitment),
        ephemeralX: ephPub[0],
        packedCiphertext: ct.map(hex),
        tag: discoveryTag(inPub).toBigInt(),
        cekWrap: cekWrap.toBigInt(),
      },
    } as UnprocessedEvent;
  }

  function repoFor(): FixtureKeyRepo {
    const tag = discoveryTag(publicKey(IN_KEY));
    return new FixtureKeyRepo(
      new Map(),
      new Map([
        [new Fr(tag.toBigInt()).toString(), { inKey: IN_KEY, index: 0 }],
      ]),
      new Fr(0n),
      publicKey(new Fr(1n)),
    );
  }

  it("registers a valid incoming note (owner == recipient)", async () => {
    const owner = await pubkeyOwner(publicKey(IN_KEY));
    const note = await new NoteProcessor(repoFor(), COMPLIANCE_PK).process(
      await memoEventFor(owner),
    );
    expect(note).not.toBeNull();
    expect(note!.note.owner.equals(owner)).toBe(true);
    expect(note!.isIncoming).toBe(true);
  });

  it("drops a mismatched incoming note (owner != recipient) as a phantom", async () => {
    const wrongOwner = await pubkeyOwner(publicKey(new Fr(999n)));
    const note = await new NoteProcessor(repoFor(), COMPLIANCE_PK).process(
      await memoEventFor(wrongOwner),
    );
    expect(note).toBeNull();
  });
});

describe("atomic self-ephemeral counter durability", () => {
  it("advances write-ahead, serializes concurrent mints, and never reuses an index across restart", async () => {
    const account = await SolanaAccount.fromSeed(MNEMONIC);
    const repo = new KeyRepository(
      account,
      new InMemoryEphemeralCounterStore(),
    );

    const first = await repo.nextSelfEphemeral();
    const second = await repo.nextSelfEphemeral();
    expect(second.index).toBeGreaterThan(first.index);
    expect(first.eph.equals(second.eph)).toBe(false);
    expect(repo.getState().selfMintCounter).toBe(second.index + 1);

    const [third, fourth] = await Promise.all([
      repo.nextSelfEphemeral(),
      repo.nextSelfEphemeral(),
    ]);
    expect(third.index).not.toBe(fourth.index);

    const priorIndices = [first, second, third, fourth];
    const priorMax = Math.max(...priorIndices.map((m) => m.index));

    const fresh = new KeyRepository(
      account,
      new InMemoryEphemeralCounterStore(),
    );
    await fresh.restore(repo.getState());
    const resumed = await fresh.nextSelfEphemeral();

    expect(resumed.index).toBeGreaterThan(priorMax);
    expect(priorIndices.some((m) => m.eph.equals(resumed.eph))).toBe(false);
  });
});
