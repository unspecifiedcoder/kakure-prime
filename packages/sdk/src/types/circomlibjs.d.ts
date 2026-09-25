// `circomlibjs` ships no types. Only the one export `crypto/PoseidonV1.ts` needs is declared here.
declare module "circomlibjs" {
  export interface CircomPoseidonField {
    toObject(value: unknown): bigint;
  }
  export interface CircomPoseidon {
    (inputs: readonly bigint[]): unknown;
    F: CircomPoseidonField;
  }
  export function buildPoseidon(): Promise<CircomPoseidon>;
}
