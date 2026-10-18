import type { Box, NonMandatoryRegisters } from "@fleet-sdk/common";
import { OutputBuilder } from "@fleet-sdk/core";

type OrderRegister = "R4" | "R5" | "R6";

/**
 * Rebuilds the recreated order output from scratch.
 *
 * `OutputBuilder.from(box)` copies every token and register of the spent box. Anything a previous
 * taker attached (extra tokens, junk registers) would then be carried into every later order box,
 * growing it, raising its minimum value and eventually making fills fail. This keeps only the
 * tokens and registers the contract itself reads.
 *
 * @param box - The order box being spent.
 * @param tokenIds - The token ids the order is made of (quote, plus base for token/token grids).
 * @param registers - The registers the contract expects the recreated box to preserve.
 */
export function recreateOrderOutput(
  box: Box<bigint>,
  tokenIds: readonly string[],
  registers: readonly OrderRegister[],
): OutputBuilder {
  const keep = new Set(tokenIds);
  const output = new OutputBuilder(box.value, box.ergoTree).addTokens(
    box.assets.filter((asset) => keep.has(asset.tokenId)),
  );

  const kept: NonMandatoryRegisters = {};
  for (const register of registers) {
    const value = box.additionalRegisters[register];
    if (value) kept[register] = value;
  }

  return output.setAdditionalRegisters(kept);
}
