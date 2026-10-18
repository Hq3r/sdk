import {
  ensureUTxOBigInt,
  first,
  type Amount,
  type Box,
  type BoxCandidate,
} from "@fleet-sdk/common";
import {
  type ErgoAddress,
  estimateMinBoxValue,
  OutputBuilder,
  type FleetPlugin,
  ErgoUnsignedInput,
  type R4ToR5Registers,
} from "@fleet-sdk/core";
import {
  SBool,
  SByte,
  SColl,
  SConstant,
  SGroupElement,
  SInt,
  SLong,
  SSigmaProp,
} from "@fleet-sdk/serializer";

import { OrderContract } from "./order-contract";
import { recreateOrderOutput } from "./recreate";
import { validateToken } from "./tokens";
import type { ActionHandler, BuySellOrder, ExchangeableAssets, PriceRange } from "./types";

const CONTRACTS = {
  E2T: new OrderContract(
    "19ab020f0e20cafe05e06b54b00eb0067c7c5e900c4d394030f4ac2e351f873a28f6158ced6e05000400040004040400050004020500040004020500040005000402d804d601e30104d6027300d603860272027301d604e4c6a7040895e67201d805d605e4c6a70511d606b2a5e4720100d607b2db630872067302017203d6088cb2db6308a7730301720302d6098c720702d1ededededed93b17205730491b27205730500730691b27205730700730892b27205730900b27205730a00edededed93c27206c2a7938c720701720293e4c672060408720493e4c672060511720593e4c67206060ec5a795e4e30001d801d60a99c17206c1a7ed91720a730b92720a9c9972087209b27205730c00d801d60a9972097208ed91720a730d929c720ab27205730e0099c1a7c172067204",
    "E2T",
  ),
  T2T: new OrderContract(
    "19ec02110e20cafe05e06b54b00eb0067c7c5e900c4d394030f4ac2e351f873a28f6158ced6e0500040004000402040204040400050004020500040004020500040005000402d804d601e30104d6027300d603860272027301d604e4c6a7040895e67201d80cd605db6308a7d606b27205730200d6078c720601d608e4c6a70511d609b2a5e4720100d60adb63087209d60bb2720a730300d60cb2720a7304017203d60d8c720b02d60e8c720602d60f8cb27205730501720302d6108c720c02d1ededed9472077202ededed93b17208730691b27208730700730891b27208730900730a92b27208730b00b27208730c00edededededed93c27209c2a793c17209c1a79372078c720b01938c720c01720293e4c672090408720493e4c672090511720893e4c67209060ec5a795e4e30001d801d61199720d720eed917211730d9272119c99720f7210b27208730e00d801d611997210720fed917211730f929c7211b2720873100099720e720d7204",
    "T2T",
  ),
};

export class GridOrder implements BuySellOrder<PriceRange> {
  #box: Box<bigint, R4ToR5Registers>;
  #price: PriceRange;
  #assets: ExchangeableAssets;
  #contract: OrderContract;

  constructor(box: Box<Amount, R4ToR5Registers> | BoxCandidate<Amount, R4ToR5Registers>) {
    if (CONTRACTS.E2T.validate(box.ergoTree)) {
      this.#contract = CONTRACTS.E2T;
    } else if (CONTRACTS.T2T.validate(box.ergoTree)) {
      this.#contract = CONTRACTS.T2T;
    } else {
      throw Error("Invalid Grid Order contract");
    }

    this.#box = ensureUTxOBigInt(box) as Box<bigint, R4ToR5Registers>;
    const quoteId = this.#contract.getQuoteId(box.ergoTree);

    if (this.#contract.type === "E2T") {
      if (!validateToken(quoteId, box, 0)) throw Error("Invalid quote token for the contract");
      this.#assets = {
        base: { tokenId: "ERG", amount: this.#box.value },
        quote: { tokenId: quoteId, amount: this.#box.assets[0]?.amount ?? 0n },
      };
    } else {
      const baseId = this.#box.assets[0]?.tokenId;
      if (!baseId) throw Error("The base token is not specified in the box");
      if (!validateToken(quoteId, box, 1)) throw Error("Invalid quote token for the contract");
      if (baseId === quoteId) throw Error("Base and quote assets must be different");

      this.#assets = {
        /* c8 ignore next 2 -- assets[0/1] always exist here: guarded by !baseId and validateToken above */
        base: { tokenId: baseId, amount: this.#box.assets[0]?.amount ?? 0n },
        quote: { tokenId: quoteId, amount: this.#box.assets[1]?.amount ?? 0n },
      };
    }

    const prices = SConstant.from<[bigint, bigint]>(box.additionalRegisters.R5);
    if (prices.type.toString() !== "SColl[SLong]") throw Error("Invalid price register");
    if (prices.data.length !== 2 || prices.data[0] <= 0n || prices.data[1] <= 0n)
      throw Error("Grid prices must contain two positive values");
    if (prices.data[0] < prices.data[1])
      throw Error("Unsafe grid spread: taker buy price must be greater than or equal to taker sell price");
    this.#price = { buy: prices.data[0], sell: prices.data[1] };
  }

  get box(): Box<bigint, R4ToR5Registers> {
    return this.#box;
  }

  get price(): PriceRange {
    return this.#price;
  }

  get assets(): ExchangeableAssets {
    return this.#assets;
  }

  get contract(): OrderContract {
    return this.#contract;
  }

  /**
   * Buys tokens with nanoergs at the price specified in the order.
   * @param amount - The amount of token units to buy.
   */
  buy(amount: bigint, handler?: ActionHandler): FleetPlugin {
    if (amount <= 0n) throw Error("Amount must be greater than zero");
    if (amount > this.#assets.quote.amount)
      throw Error("Amount exceeds the available quote tokens");

    return ({ addInputs, addOutputs }) => {
      const box = this.#box;
      const requiredBase = amount * this.#price.buy;

      const input = new ErgoUnsignedInput(box);
      const output = recreateOrderOutput(
        box,
        this.#contract.type === "E2T"
          ? [this.#assets.quote.tokenId]
          : [this.#assets.base.tokenId, this.#assets.quote.tokenId],
        ["R4", "R5"],
      );

      if (this.#contract.type === "E2T") {
        output
          .setValue(box.value + requiredBase)
          .addTokens({ tokenId: this.#assets.quote.tokenId, amount: amount * -1n }); // fleet will deduct the amount from the existing tokens
      } else {
        output
          .addTokens({ tokenId: this.#assets.base.tokenId, amount: requiredBase }) // fleet will sum the amount to the existing tokens
          .addTokens({ tokenId: this.#assets.quote.tokenId, amount: amount * -1n }); // fleet will sum the amount to the existing tokens
      }

      const outputsLength = addOutputs(
        output.setAdditionalRegisters({ R6: SColl(SByte, box.boxId) }), // bind the output to the input
      );

      addInputs(
        input.setContextExtension({
          0: SBool(true), // action, true == buy
          1: SInt(outputsLength - 1), // index of the child output
        }),
      );

      if (handler) handler(output, input);
    };
  }

  /**
   * Sell tokens for nanoergs at the price specified in the order.
   * @param amount - The amount of token units to sell.
   */
  sell(amount: bigint, handler?: ActionHandler): FleetPlugin {
    if (amount <= 0n) throw Error("Amount must be greater than zero");
    if (amount * this.#price.sell > this.#assets.base.amount)
      throw Error("Insufficient base amount to cover the payout");

    return ({ addInputs, addOutputs }) => {
      const box = this.#box;
      const basePayout = amount * this.#price.sell;

      const input = new ErgoUnsignedInput(box);
      const output = recreateOrderOutput(
        box,
        this.#contract.type === "E2T"
          ? [this.#assets.quote.tokenId]
          : [this.#assets.base.tokenId, this.#assets.quote.tokenId],
        ["R4", "R5"],
      );

      if (this.#contract.type === "E2T") {
        output
          .setValue(box.value - basePayout)
          .addTokens({ tokenId: this.#assets.quote.tokenId, amount }); // fleet will sum the amount to the existing tokens
      } else {
        output
          .addTokens({ tokenId: this.#assets.base.tokenId, amount: basePayout * -1n }) // fleet will deduct the amount from the existing tokens
          .addTokens({ tokenId: this.#assets.quote.tokenId, amount }); // fleet will sum the amount to the existing tokens
      }

      const outputsLength = addOutputs(
        output.setAdditionalRegisters({ R6: SColl(SByte, box.boxId) }), // bind the output to the input box
      );

      addInputs(
        input.setContextExtension({
          0: SBool(false), // action, false == sell
          1: SInt(outputsLength - 1), // index of the child output
        }),
      );

      if (handler) handler(output, input);
    };
  }

  close(): FleetPlugin {
    return ({ addInputs }) => addInputs(this.#box);
  }

  static create(options: GridOrderCreationParams): OutputBuilder {
    const assets = options.assets;
    if (assets.quote.tokenId === "ERG") throw Error("Quote asset cannot be ERG");
    if (assets.base.tokenId === assets.quote.tokenId)
      throw Error("Base and quote assets must be different");
    if (!assets?.base.amount && !assets?.quote.amount)
      throw Error("At least one of base or quote assets must be specified");
    if (!options.prices.buy || !options.prices.sell)
      throw Error("Prices must be specified for both buy and sell");
    if (options.prices.buy <= 0n || options.prices.sell <= 0n)
      throw Error("Grid prices must be positive");
    if (options.prices.buy < options.prices.sell)
      throw Error("Unsafe grid spread: taker buy price must be greater than or equal to taker sell price");

    let builder: OutputBuilder;
    if (assets.base.tokenId === "ERG") {
      const contract = CONTRACTS.E2T.new(assets.quote.tokenId);
      const baseAmount = assets.base.amount || estimateMinBoxValue();

      builder = new OutputBuilder(baseAmount, contract).addTokens(assets.quote);
    } else {
      const contract = CONTRACTS.T2T.new(assets.quote.tokenId);

      builder = new OutputBuilder(estimateMinBoxValue(), contract)
        .addTokens(assets.base)
        .addTokens(assets.quote);
    }

    return builder.setAdditionalRegisters({
      R4: SSigmaProp(SGroupElement(first(options.owner.getPublicKeys()))),
      R5: SColl(SLong, [options.prices.buy, options.prices.sell]),
    });
  }
}

export interface GridOrderCreationParams {
  owner: ErgoAddress;
  assets: ExchangeableAssets;
  prices: PriceRange;
}
