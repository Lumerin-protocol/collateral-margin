import type { Address, PublicClient } from "viem";
import type pino from "pino";
import Fraction from "fraction.js";
import { RollingWindow } from "./math.ts";

export interface GasTrackerConfig {
  /** Chainlink aggregator address; if absent, ethPriceUsd stays 0. */
  ethPriceFeedAddress?: Address;
  gasSpikeThresholdPct: number;
  gasCapMultiplier: number;
}

const aggregatorV3InterfaceAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export class GasTracker {
  currentGasPrice = 0n;
  /** Fraction representation of median gas price (bigint is nicer but RollingWindow gives us bigint median so we store bigint). */
  medianGasPrice = 0n;
  /** Gas spike as Fraction (percentage). */
  gasSpikePct: Fraction = new Fraction(0n);
  isGasSpiking = false;

  estimatedCreateGas = 300_000n;
  estimatedCancelGas = 100_000n;

  /** Current ETH price scaled to 6-decimal USDC terms. */
  ethPriceUsd = 0n;

  private readonly publicClient: PublicClient;
  private readonly config: GasTrackerConfig;
  private readonly gasWindow: RollingWindow;
  private readonly logger: pino.Logger;

  constructor(publicClient: PublicClient, config: GasTrackerConfig, logger: pino.Logger) {
    this.publicClient = publicClient;
    this.config = config;
    this.gasWindow = new RollingWindow(60);
    this.logger = logger.child({ component: "gas" });
  }

  async update(): Promise<void> {
    this.currentGasPrice = await this.publicClient.getGasPrice();
    this.gasWindow.push(this.currentGasPrice);
    this.medianGasPrice = this.gasWindow.median();

    if (this.medianGasPrice > 0n) {
      const diff = this.currentGasPrice - this.medianGasPrice;
      this.gasSpikePct = new Fraction(diff, this.medianGasPrice).mul(new Fraction(100n));
    } else {
      this.gasSpikePct = new Fraction(0n);
    }

    this.isGasSpiking = this.gasSpikePct.compare(new Fraction(this.config.gasSpikeThresholdPct)) > 0;

    if (this.config.ethPriceFeedAddress) {
      await this.updateEthPrice();
    }

    this.logger.debug(
      { gasPrice: this.currentGasPrice.toString(), spiking: this.isGasSpiking },
      "gas tick",
    );
  }

  /**
   * Cost of `gasUnits` gas at the current price, expressed in 6-decimal USDC units.
   * Returns 0n if ETH price is unknown.
   */
  gasCostUsd(gasUnits: bigint): bigint {
    if (this.ethPriceUsd === 0n) return 0n;
    return (gasUnits * this.currentGasPrice * this.ethPriceUsd) / 10n ** 18n;
  }

  get placeCostUsd(): bigint {
    return this.gasCostUsd(this.estimatedCreateGas);
  }

  get cancelCostUsd(): bigint {
    return this.gasCostUsd(this.estimatedCancelGas);
  }

  get roundTripCostUsd(): bigint {
    return this.cancelCostUsd + this.placeCostUsd;
  }

  requoteCycleCostUsd(totalOrders: number): bigint {
    return BigInt(totalOrders) * this.roundTripCostUsd;
  }

  cappedGasPrice(): bigint {
    if (this.medianGasPrice === 0n) return this.currentGasPrice;
    // cap = median * capMultiplier; use bigint arithmetic with 1000-precision
    const multPrecision = 1000n;
    const mult = BigInt(Math.round(this.config.gasCapMultiplier * 1000));
    const cap = (this.medianGasPrice * mult) / multPrecision;
    return this.currentGasPrice < cap ? cap : this.currentGasPrice;
  }

  /** Calibrate gas estimates against a candidate transaction. Adapters provide the tx. */
  async calibrate(estimator: () => Promise<bigint>): Promise<void> {
    try {
      const gas = await estimator();
      if (gas > 0n) {
        this.estimatedCreateGas = gas;
        this.logger.info({ createGas: gas.toString() }, "calibrated createOrder gas");
      }
    } catch (err) {
      this.logger.warn({ err }, "gas calibration failed, using defaults");
    }
  }

  private async updateEthPrice(): Promise<void> {
    try {
      const [[, answer], decimals] = await this.publicClient.multicall({
        allowFailure: false,
        contracts: [
          {
            address: this.config.ethPriceFeedAddress!,
            abi: aggregatorV3InterfaceAbi,
            functionName: "latestRoundData",
          },
          {
            address: this.config.ethPriceFeedAddress!,
            abi: aggregatorV3InterfaceAbi,
            functionName: "decimals",
          },
        ],
      });
      if (answer > 0n) {
        this.ethPriceUsd = scaleDecimals(answer, BigInt(decimals), 6n);
      }
    } catch {
      this.logger.warn("ETH price feed read failed");
    }
  }
}

function scaleDecimals(value: bigint, from: bigint, to: bigint): bigint {
  return from >= to ? value / 10n ** (from - to) : value * 10n ** (to - from);
}
