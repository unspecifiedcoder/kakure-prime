import type { Point } from "@kakure/sdk/tss";

export function pointToHex(p: Point): { x: string; y: string } {
  return { x: p[0].toString(16), y: p[1].toString(16) };
}
export function pointFromHex(h: { x: string; y: string }): Point {
  return [BigInt("0x" + h.x), BigInt("0x" + h.y)];
}
