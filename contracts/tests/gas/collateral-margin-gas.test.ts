import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AbiItem,
  assertAbiFunctionCoverage,
  GasRecorder,
  writeSnapshot,
} from "@lsheva/evm-gas-benchmark";
import { network } from "hardhat";
import {
  type Address,
  encodeFunctionData,
  type Hash,
  type Hex,
  parseSignature,
  type PublicClient,
} from "viem";
import { CollateralVaultAbi } from "../../abi/CollateralVault.ts";
import { PointsAbi } from "../../abi/Points.ts";
import { PointsHookAbi } from "../../abi/PointsHook.ts";
import { PointsRedeemerAbi } from "../../abi/PointsRedeemer.ts";
import { PortfolioMarginEngineAbi } from "../../abi/PortfolioMarginEngine.ts";
import { DEFAULT_MARKET_PRICE } from "../fixtures.js";
import {
  deployCollateralGasFixture,
  deployPointsGasFixture,
} from "./fixtures.ts";

const { viem, networkHelpers } = await network.getOrCreate();
const SNAPSHOT_PATH = fileURLToPath(
  new URL("../../benchmarks/collateral-margin-gas.json", import.meta.url),
);

/**
 * Measurement ids sort by group first, so the report reads hot path first and admin last:
 * a few hundred gas matters on a call every order makes, not on one an owner makes yearly.
 */
const GROUP = {
  hot: "1 per order and fill",
  user: "2 user",
  risk: "3 risk and liquidation",
  views: "4 views",
  admin: "5 admin and lifecycle",
} as const;
type Group = (typeof GROUP)[keyof typeof GROUP];

const CONTRACTS = {
  CollateralVault: CollateralVaultAbi,
  PortfolioMarginEngine: PortfolioMarginEngineAbi,
  Points: PointsAbi,
  PointsHook: PointsHookAbi,
  PointsRedeemer: PointsRedeemerAbi,
} as const;
type ContractName = keyof typeof CONTRACTS;
const recorders = Object.fromEntries(
  Object.keys(CONTRACTS).map((name) => [name, new GasRecorder()]),
) as Record<ContractName, GasRecorder>;

const PROXY_EXCLUSIONS = {
  "proxiableUUID()":
    "OpenZeppelin UUPS marks proxiableUUID notDelegated, so it intentionally reverts through the deployed proxy and is callable only on the implementation.",
};
const DISABLED_ERC20 =
  "Receipt balances are non-transferable: the function is pure and always reverts.";
const exclusions: Record<ContractName, Record<string, string>> = {
  CollateralVault: {
    ...PROXY_EXCLUSIONS,
    "initialize(address)":
      "The deployed UUPS proxy is already initialized, while the implementation constructor disables initializers; no successful independent call exists after deployment.",
    "allowance(address,address)": DISABLED_ERC20,
    "approve(address,uint256)": DISABLED_ERC20,
    "transfer(address,uint256)": DISABLED_ERC20,
    "transferFrom(address,address,uint256)": DISABLED_ERC20,
  },
  PortfolioMarginEngine: {
    ...PROXY_EXCLUSIONS,
    "initialize()":
      "The deployed UUPS proxy is already initialized, while the implementation constructor disables initializers; no successful independent call exists after deployment.",
  },
  Points: {
    "approve(address,uint256)": DISABLED_ERC20,
    "transfer(address,uint256)": DISABLED_ERC20,
    "transferFrom(address,address,uint256)": DISABLED_ERC20,
  },
  PointsHook: {},
  PointsRedeemer: {},
};

type Target = { contract: ContractName; address: Address; group: Group };

function identity(target: Target, signature: string, scenario: string) {
  return {
    function: signature,
    scenario,
    id: `${target.group} · ${target.contract}.${signature}::${scenario}`,
  };
}

async function tx(
  pc: PublicClient,
  target: Target,
  signature: string,
  scenario: string,
  send: Promise<Hash>,
) {
  const receipt = await pc.waitForTransactionReceipt({ hash: await send });
  assert.equal(
    receipt.status,
    "success",
    `${target.contract}.${signature} ${scenario}`,
  );
  recorders[target.contract].recordTransaction(
    identity(target, signature, scenario),
    receipt,
  );
}

async function view(
  pc: PublicClient,
  target: Target,
  signature: string,
  args: readonly unknown[] = [],
  scenario = "representative",
  account?: Address,
) {
  const functionName = signature.slice(0, signature.indexOf("("));
  const data = encodeFunctionData({
    abi: CONTRACTS[target.contract],
    functionName,
    args,
  } as never);
  const estimated = await pc.estimateGas({
    to: target.address,
    data,
    ...(account ? { account } : {}),
  });
  recorders[target.contract].recordViewEstimate(
    identity(target, signature, scenario),
    estimated,
  );
}

const freshCollateral = () =>
  networkHelpers.loadFixture(deployCollateralGasFixture);
const freshPoints = () => networkHelpers.loadFixture(deployPointsGasFixture);
type CollateralFixture = Awaited<ReturnType<typeof deployCollateralGasFixture>>;

/** One account with exposure on both linear venues and the options engine. */
async function representativePortfolio(fx: CollateralFixture, user: Address) {
  await fx.perpsMock.write.setUserPosition([
    user,
    1_000_000n,
    DEFAULT_MARKET_PRICE,
  ]);
  await fx.perpsMock.write.setOrderDeltas([user, 500_000n, 250_000n]);
  await fx.perpsMock.write.setOrderFillLosses([user, 1_000_000n, 2_000_000n]);
  await fx.perpsMock.write.setUnrealizedPnl([user, -100_000_000n]);
  await fx.perpsMock.write.setPendingFunding([user, 10_000_000n]);
  await fx.futuresMock.write.setNetPositionDelta([user, -500_000n]);
  await fx.futuresMock.write.setOrderDeltas([user, 200_000n, 0n]);
  await fx.optionsMock.write.setNetGreeks([
    user,
    100_000_000_000_000_000n,
    10n ** 18n,
    10n ** 18n,
  ]);
  await fx.optionsMock.write.setReservedMargin([
    user,
    1_000_000_000_000_000_000n,
  ]);
}

async function benchmarkVault() {
  const vaultAt = (fx: CollateralFixture, group: Group): Target => ({
    contract: "CollateralVault",
    address: fx.vault.address,
    group,
  });
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const hot = vaultAt(fx, GROUP.hot);
    const insurance = await fx.vault.read.INSURANCE_FUND_ADDR();
    const venue = { account: fx.venue.account };
    const [alice, bob] = [fx.alice.account.address, fx.bob.account.address];
    await tx(
      pc,
      hot,
      "settleTransfer(address,address,uint256)",
      "trader to trader",
      fx.vault.write.settleTransfer([alice, bob, 100_000_000n], venue),
    );
    await tx(
      pc,
      hot,
      "settleTransfer(address,address,uint256)",
      "insurance fund pays a winner",
      fx.vault.write.settleTransfer([insurance, alice, 100_000_000n], venue),
    );
    await tx(
      pc,
      hot,
      "settleTransfer(address,address,uint256)",
      "loser short, bad debt",
      fx.vault.write.settleTransfer([bob, alice, 20_000_000_000n], venue),
    );
    await tx(
      pc,
      hot,
      "settleTransfer(address,address,uint256)",
      "fund shortfall borrows insurance debt",
      fx.vault.write.settleTransfer([insurance, alice, 20_000_000_000n], venue),
    );
    await view(pc, hot, "halted()");
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const hot = vaultAt(fx, GROUP.hot);
    const venue = { account: fx.venue.account };
    const [alice, bob] = [fx.alice.account.address, fx.bob.account.address];
    await tx(
      pc,
      hot,
      "internalTransfer(address,address,uint256)",
      "trader to trader",
      fx.vault.write.internalTransfer([alice, bob, 100_000_000n], venue),
    );
    await representativePortfolio(fx, alice);
    await tx(
      pc,
      hot,
      "internalTransferWithMarginCheck(address,address,uint256)",
      "portfolio margin checked",
      fx.vault.write.internalTransferWithMarginCheck(
        [alice, bob, 100_000_000n],
        venue,
      ),
    );
    await view(pc, hot, "balanceOf(address)", [alice]);
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const user = vaultAt(fx, GROUP.user);
    const carol = fx.carol.account.address;
    await tx(
      pc,
      user,
      "deposit(uint256)",
      "first deposit",
      fx.vault.write.deposit([1_000_000_000n], { account: fx.carol.account }),
    );
    await tx(
      pc,
      user,
      "deposit(uint256)",
      "top-up",
      fx.vault.write.deposit([1_000_000_000n], { account: fx.alice.account }),
    );
    await tx(
      pc,
      user,
      "depositFor(address,uint256)",
      "for another account",
      fx.vault.write.depositFor([carol, 1_000_000_000n], {
        account: fx.alice.account,
      }),
    );
    await representativePortfolio(fx, fx.alice.account.address);
    await tx(
      pc,
      user,
      "withdraw(uint256)",
      "partial, margin checked",
      fx.vault.write.withdraw([1_000_000_000n], { account: fx.alice.account }),
    );
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const owner = fx.owner;
    const amount = 1_000_000_000n;
    const deadline = 2_000_000_000n;
    const signature = await owner.signTypedData({
      domain: {
        name: await fx.usdc.read.name(),
        version: "1",
        chainId: await pc.getChainId(),
        verifyingContract: fx.usdc.address,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: owner.account.address,
        spender: fx.vault.address,
        value: amount,
        nonce: await fx.usdc.read.nonces([owner.account.address]),
        deadline,
      },
    });
    const { v, r, s } = parseSignature(signature);
    await tx(
      pc,
      vaultAt(fx, GROUP.user),
      "depositForPermit(address,uint256,uint256,uint8,bytes32,bytes32)",
      "permit then deposit",
      fx.vault.write.depositForPermit(
        [
          fx.carol.account.address,
          amount,
          deadline,
          Number(v),
          r as Hex,
          s as Hex,
        ],
        {
          account: owner.account,
        },
      ),
    );
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const views = vaultAt(fx, GROUP.views);
    const user = fx.alice.account.address;
    for (const [signature, args] of [
      ["BACKSTOP_ADDR()", []],
      ["INSURANCE_FUND_ADDR()", []],
      ["MAX_BACKSTOP_PARAM_BPS()", []],
      ["UPGRADE_INTERFACE_VERSION()", []],
      ["VERSION()", []],
      ["authorizedCallers(address)", [fx.venue.account.address]],
      ["backstopParams()", []],
      ["backstopUnwindBandBps()", []],
      ["backstopUnwindFeeBps()", []],
      ["collateralToken()", []],
      ["decimals()", []],
      ["effectiveInsuranceDebtCap()", []],
      ["insuranceCapital()", []],
      ["insuranceDebt()", []],
      ["insuranceDebtCap()", []],
      ["insuranceFundBalance()", []],
      ["marginEngine()", []],
      ["name()", []],
      ["owner()", []],
      ["symbol()", []],
      ["timingDebt()", []],
      ["totalSupply()", []],
      ["traderBadDebtTotal()", []],
      ["uncoveredLoss()", []],
    ] as const) {
      await view(pc, views, signature, args, "representative", user);
    }
  }
  const admin = async (
    signature: string,
    scenario: string,
    send: (fx: CollateralFixture) => Promise<Hash>,
  ) => {
    const fx = await freshCollateral();
    await tx(
      await viem.getPublicClient(),
      vaultAt(fx, GROUP.admin),
      signature,
      scenario,
      send(fx),
    );
  };
  const asOwner = (fx: CollateralFixture) => ({ account: fx.owner.account });
  await admin("depositInsuranceFund(uint256)", "top-up", (fx) =>
    fx.vault.write.depositInsuranceFund([1_000_000_000n], asOwner(fx)),
  );
  await admin("withdrawInsuranceFund(address,uint256)", "partial", (fx) =>
    fx.vault.write.withdrawInsuranceFund(
      [fx.owner.account.address, 1_000_000_000n],
      asOwner(fx),
    ),
  );
  {
    const fx = await freshCollateral();
    const backstop = await fx.vault.read.BACKSTOP_ADDR();
    await fx.vault.write.depositFor([backstop, 1_000_000_000n], asOwner(fx));
    await tx(
      await viem.getPublicClient(),
      vaultAt(fx, GROUP.admin),
      "withdrawBackstop(address,uint256)",
      "sweep gains",
      fx.vault.write.withdrawBackstop(
        [fx.owner.account.address, 1_000_000_000n],
        asOwner(fx),
      ),
    );
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    await tx(
      pc,
      vaultAt(fx, GROUP.admin),
      "halt()",
      "live vault",
      fx.vault.write.halt(asOwner(fx)),
    );
    await tx(
      pc,
      vaultAt(fx, GROUP.admin),
      "resume()",
      "after a manual halt",
      fx.vault.write.resume(asOwner(fx)),
    );
  }
  {
    // A venue sends its own balance out, e.g. collected fees on withdrawCollectedFees.
    const fx = await freshCollateral();
    await fx.vault.write.depositFor(
      [fx.venue.account.address, 1_000_000_000n],
      asOwner(fx),
    );
    await tx(
      await viem.getPublicClient(),
      vaultAt(fx, GROUP.admin),
      "withdrawTo(address,uint256)",
      "venue sweeps its balance",
      fx.vault.write.withdrawTo([fx.owner.account.address, 1_000_000_000n], {
        account: fx.venue.account,
      }),
    );
  }
  await admin("setAuthorizedCaller(address,bool)", "authorize a venue", (fx) =>
    fx.vault.write.setAuthorizedCaller(
      [fx.carol.account.address, true],
      asOwner(fx),
    ),
  );
  await admin("setBackstopParams(uint16,uint16)", "band and fee", (fx) =>
    fx.vault.write.setBackstopParams([100, 10], asOwner(fx)),
  );
  await admin("setInsuranceDebtCap(uint256)", "raise", (fx) =>
    fx.vault.write.setInsuranceDebtCap([1_000_000_000_000n], asOwner(fx)),
  );
  await admin("setMarginEngine(address)", "revalidate current engine", (fx) =>
    fx.vault.write.setMarginEngine([fx.pme.address], asOwner(fx)),
  );
  await admin("initializeV2()", "fresh proxy", (fx) =>
    fx.vault.write.initializeV2(asOwner(fx)),
  );
  {
    const fx = await freshCollateral();
    const implementation = await viem.deployContract("CollateralVault", []);
    await tx(
      await viem.getPublicClient(),
      vaultAt(fx, GROUP.admin),
      "upgradeToAndCall(address,bytes)",
      "new compatible implementation",
      fx.vault.write.upgradeToAndCall(
        [implementation.address, "0x"],
        asOwner(fx),
      ),
    );
  }
  await admin("transferOwnership(address)", "to another account", (fx) =>
    fx.vault.write.transferOwnership([fx.alice.account.address], asOwner(fx)),
  );
  await admin("renounceOwnership()", "current owner", (fx) =>
    fx.vault.write.renounceOwnership(asOwner(fx)),
  );
}

async function benchmarkMarginEngine() {
  const pmeAt = (fx: CollateralFixture, group: Group): Target => ({
    contract: "PortfolioMarginEngine",
    address: fx.pme.address,
    group,
  });
  for (const loaded of [false, true]) {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    const user = fx.alice.account.address;
    if (loaded) await representativePortfolio(fx, user);
    const scenario = loaded
      ? "perps, futures and options exposure"
      : "flat account";
    const [maxIm, maxMmDeficit] = await fx.pme.read.reduceLimits([user]);
    await view(
      pc,
      pmeAt(fx, GROUP.hot),
      "reduceLimits(address)",
      [user],
      scenario,
    );
    await view(
      pc,
      pmeAt(fx, GROUP.hot),
      "meetsTradeMargin(address,uint256,uint256)",
      [user, maxIm, maxMmDeficit],
      scenario,
    );
    await view(
      pc,
      pmeAt(fx, GROUP.hot),
      "canPlaceOrder(address,uint256)",
      [user, 1_000_000_000_000_000_000n],
      scenario,
    );
    for (const signature of [
      "computePortfolioIM(address)",
      "computePortfolioMM(address)",
      "computePortfolioMargins(address)",
      "isHealthy(address)",
      "isLiquidatable(address)",
      "orderMarginOf(address)",
      "hasRestingOrderDelta(address)",
    ]) {
      await view(pc, pmeAt(fx, GROUP.risk), signature, [user], scenario);
    }
  }
  {
    const fx = await freshCollateral();
    const pc = await viem.getPublicClient();
    for (const [signature, args] of [
      ["UPGRADE_INTERFACE_VERSION()", []],
      ["VERSION()", []],
      ["getLinearMarkets()", []],
      ["imSpotShock()", []],
      ["imVolShock()", []],
      ["linearOrderMargin(uint256)", [50_000_000_000n]],
      ["mmSpotShock()", []],
      ["mmVolShock()", []],
      ["optionsEngine()", []],
      ["owner()", []],
      ["priceOracle()", []],
      ["vault()", []],
    ] as const) {
      await view(pc, pmeAt(fx, GROUP.views), signature, args);
    }
  }
  const admin = async (
    signature: string,
    scenario: string,
    send: (fx: CollateralFixture) => Promise<Hash>,
  ) => {
    const fx = await freshCollateral();
    await tx(
      await viem.getPublicClient(),
      pmeAt(fx, GROUP.admin),
      signature,
      scenario,
      send(fx),
    );
  };
  const asOwner = (fx: CollateralFixture) => ({ account: fx.owner.account });
  {
    const fx = await freshCollateral();
    const market = await viem.deployContract("FuturesMock", []);
    await market.write.setVault([fx.vault.address]);
    await tx(
      await viem.getPublicClient(),
      pmeAt(fx, GROUP.admin),
      "addLinearMarket(address)",
      "third venue",
      fx.pme.write.addLinearMarket([market.address], asOwner(fx)),
    );
  }
  await admin("removeLinearMarket(address)", "registered venue", (fx) =>
    fx.pme.write.removeLinearMarket([fx.futuresMock.address], asOwner(fx)),
  );
  await admin("setOptions(address)", "revalidate current engine", (fx) =>
    fx.pme.write.setOptions([fx.optionsMock.address], asOwner(fx)),
  );
  {
    const fx = await freshCollateral();
    const oracle = await viem.deployContract("PriceOracleMock", [
      DEFAULT_MARKET_PRICE,
      6,
    ]);
    await tx(
      await viem.getPublicClient(),
      pmeAt(fx, GROUP.admin),
      "setOracle(address)",
      "replace live feed",
      fx.pme.write.setOracle([oracle.address], asOwner(fx)),
    );
  }
  await admin("setShocks(uint256,uint256,uint256,uint256)", "all four", (fx) =>
    fx.pme.write.setShocks(
      [2n * 10n ** 17n, 10n ** 17n, 15n * 10n ** 16n, 8n * 10n ** 16n],
      asOwner(fx),
    ),
  );
  await admin("initializeV2()", "fresh proxy", (fx) =>
    fx.pme.write.initializeV2(asOwner(fx)),
  );
  {
    const fx = await freshCollateral();
    const implementation = await viem.deployContract("PortfolioMarginEngine", [
      fx.vault.address,
    ]);
    await tx(
      await viem.getPublicClient(),
      pmeAt(fx, GROUP.admin),
      "upgradeToAndCall(address,bytes)",
      "new compatible implementation",
      fx.pme.write.upgradeToAndCall(
        [implementation.address, "0x"],
        asOwner(fx),
      ),
    );
  }
  await admin("transferOwnership(address)", "to another account", (fx) =>
    fx.pme.write.transferOwnership([fx.alice.account.address], asOwner(fx)),
  );
  await admin("renounceOwnership()", "current owner", (fx) =>
    fx.pme.write.renounceOwnership(asOwner(fx)),
  );
}

type PointsFixture = Awaited<ReturnType<typeof deployPointsGasFixture>>;

async function benchmarkPoints() {
  const at = (
    contract: ContractName,
    address: Address,
    group: Group,
  ): Target => ({ contract, address, group });
  const asOwner = (fx: PointsFixture) => ({ account: fx.owner.account });
  {
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    const hook = at("PointsHook", fx.hook.address, GROUP.hot);
    const venue = { account: fx.venue.account };
    const [maker, taker] = [fx.alice.account.address, fx.bob.account.address];
    const fill = [
      maker,
      taker,
      1_000_000_000n,
      0n,
      500_000n,
      1_000_000n,
      1_000_000n,
    ] as const;
    await tx(
      pc,
      hook,
      "onFill(address,address,uint256,int256,uint256,uint256,uint256)",
      "first fill for both sides",
      fx.hook.write.onFill(fill, venue),
    );
    await tx(
      pc,
      hook,
      "onFill(address,address,uint256,int256,uint256,uint256,uint256)",
      "repeat fill",
      fx.hook.write.onFill(fill, venue),
    );
    await tx(
      pc,
      at("PointsHook", fx.hook.address, GROUP.risk),
      "onLiquidation(address,uint256)",
      "keeper points",
      fx.hook.write.onLiquidation(
        [fx.keeper.account.address, 1_000_000n],
        venue,
      ),
    );
    await tx(
      pc,
      at("Points", fx.points.address, GROUP.hot),
      "mint(address,uint256)",
      "existing holder",
      fx.points.write.mint([maker, 1_000_000n], asOwner(fx)),
    );
  }
  {
    // Redemption: mint, finalize, fund the pool, enable, then a holder swaps.
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    const admin = (contract: ContractName, address: Address) =>
      at(contract, address, GROUP.admin);
    await fx.points.write.mint(
      [fx.alice.account.address, 10_000_000n],
      asOwner(fx),
    );
    await fx.points.write.mint(
      [fx.bob.account.address, 10_000_000n],
      asOwner(fx),
    );
    await tx(
      pc,
      admin("Points", fx.points.address),
      "finalize()",
      "close minting",
      fx.points.write.finalize(asOwner(fx)),
    );
    await fx.gov.write.mint([fx.redeemer.address, 1_000_000_000n]);
    await tx(
      pc,
      admin("PointsRedeemer", fx.redeemer.address),
      "enableRedemption(uint256)",
      "funded pool",
      fx.redeemer.write.enableRedemption([1_000_000_000n], asOwner(fx)),
    );
    const user = at("PointsRedeemer", fx.redeemer.address, GROUP.user);
    await view(pc, user, "previewSwap(address)", [fx.alice.account.address]);
    await tx(
      pc,
      user,
      "swap()",
      "full balance, half liquid half escrowed",
      fx.redeemer.write.swap({ account: fx.alice.account }),
    );
    await tx(
      pc,
      admin("PointsRedeemer", fx.redeemer.address),
      "recoverGov(address,uint256)",
      "leftover pool",
      fx.redeemer.write.recoverGov(
        [fx.owner.account.address, 1_000_000n],
        asOwner(fx),
      ),
    );
  }
  {
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    await tx(
      pc,
      at("Points", fx.points.address, GROUP.user),
      "burn(address,uint256)",
      "redeemer burns a balance",
      (async () => {
        await fx.points.write.mint(
          [fx.alice.account.address, 10_000_000n],
          asOwner(fx),
        );
        await fx.points.write.grantRole(
          [fx.BURNER_ROLE, fx.owner.account.address],
          asOwner(fx),
        );
        return fx.points.write.burn(
          [fx.alice.account.address, 10_000_000n],
          asOwner(fx),
        );
      })(),
    );
  }
  {
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    const holder = fx.alice.account.address;
    await fx.points.write.mint([holder, 1_000_000n], asOwner(fx));
    const points = at("Points", fx.points.address, GROUP.views);
    for (const [signature, args] of [
      ["BURNER_ROLE()", []],
      ["DEFAULT_ADMIN_ROLE()", []],
      ["MINTER_ROLE()", []],
      ["allowance(address,address)", [holder, fx.bob.account.address]],
      ["balanceOf(address)", [holder]],
      ["decimals()", []],
      ["finalized()", []],
      ["getRoleAdmin(bytes32)", [fx.MINTER_ROLE]],
      ["hasRole(bytes32,address)", [fx.MINTER_ROLE, fx.hook.address]],
      ["name()", []],
      ["supportsInterface(bytes4)", ["0x7965db0b"]],
      ["symbol()", []],
      ["totalSupply()", []],
    ] as const) {
      await view(pc, points, signature, args);
    }
    const hook = at("PointsHook", fx.hook.address, GROUP.views);
    for (const [signature, args] of [
      ["DEFAULT_ADMIN_ROLE()", []],
      ["HOOK_CALLER_ROLE()", []],
      ["WEIGHT_SCALE()", []],
      ["getRoleAdmin(bytes32)", [fx.MINTER_ROLE]],
      ["hasRole(bytes32,address)", [fx.MINTER_ROLE, fx.venue.account.address]],
      ["keeperPoints()", []],
      ["maxMakerMult()", []],
      ["maxSpread()", []],
      ["minFee()", []],
      ["points()", []],
      ["supportsInterface(bytes4)", ["0x7965db0b"]],
      ["wMaker()", []],
      ["wTaker()", []],
    ] as const) {
      await view(pc, hook, signature, args);
    }
    const redeemer = at("PointsRedeemer", fx.redeemer.address, GROUP.views);
    for (const signature of [
      "enabled()",
      "escrow()",
      "gov()",
      "govPool()",
      "owner()",
      "points()",
      "totalPointsSnapshot()",
    ]) {
      await view(pc, redeemer, signature);
    }
  }
  type RoleOps = {
    address: Address;
    role: Hex;
    grant: (role: Hex, who: Address) => Promise<Hash>;
    revoke: (role: Hex, who: Address) => Promise<Hash>;
    renounce: (
      role: Hex,
      who: Address,
      account: PointsFixture["keeper"]["account"],
    ) => Promise<Hash>;
  };
  const roles = async (
    contract: "Points" | "PointsHook",
    ops: (fx: PointsFixture) => Promise<RoleOps>,
  ) => {
    {
      const fx = await freshPoints();
      const o = await ops(fx);
      const where = at(contract, o.address, GROUP.admin);
      const pc = await viem.getPublicClient();
      await tx(
        pc,
        where,
        "grantRole(bytes32,address)",
        "new member",
        o.grant(o.role, fx.keeper.account.address),
      );
      await tx(
        pc,
        where,
        "revokeRole(bytes32,address)",
        "existing member",
        o.revoke(o.role, fx.keeper.account.address),
      );
    }
    {
      const fx = await freshPoints();
      const o = await ops(fx);
      await o.grant(o.role, fx.keeper.account.address);
      await tx(
        await viem.getPublicClient(),
        at(contract, o.address, GROUP.admin),
        "renounceRole(bytes32,address)",
        "member leaves",
        o.renounce(o.role, fx.keeper.account.address, fx.keeper.account),
      );
    }
  };
  await roles("Points", async (fx) => ({
    address: fx.points.address,
    role: fx.MINTER_ROLE,
    grant: (role, who) => fx.points.write.grantRole([role, who], asOwner(fx)),
    revoke: (role, who) => fx.points.write.revokeRole([role, who], asOwner(fx)),
    renounce: (role, who, account) =>
      fx.points.write.renounceRole([role, who], { account }),
  }));
  await roles("PointsHook", async (fx) => ({
    address: fx.hook.address,
    role: await fx.hook.read.HOOK_CALLER_ROLE(),
    grant: (role, who) => fx.hook.write.grantRole([role, who], asOwner(fx)),
    revoke: (role, who) => fx.hook.write.revokeRole([role, who], asOwner(fx)),
    renounce: (role, who, account) =>
      fx.hook.write.renounceRole([role, who], { account }),
  }));
  {
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    const hook = at("PointsHook", fx.hook.address, GROUP.admin);
    await tx(
      pc,
      hook,
      "setKeeperPoints(uint256)",
      "change",
      fx.hook.write.setKeeperPoints([10_000_000n], asOwner(fx)),
    );
    await tx(
      pc,
      hook,
      "setMinFee(uint256)",
      "change",
      fx.hook.write.setMinFee([1_000n], asOwner(fx)),
    );
    await tx(
      pc,
      hook,
      "setPriceImprovement(uint256,uint256)",
      "change",
      fx.hook.write.setPriceImprovement(
        [2n * 10n ** 18n, 10n ** 16n],
        asOwner(fx),
      ),
    );
    await tx(
      pc,
      hook,
      "setWeights(uint256,uint256)",
      "change",
      fx.hook.write.setWeights([2n * 10n ** 18n, 10n ** 18n], asOwner(fx)),
    );
  }
  {
    const fx = await freshPoints();
    const pc = await viem.getPublicClient();
    const redeemer = at("PointsRedeemer", fx.redeemer.address, GROUP.admin);
    await tx(
      pc,
      redeemer,
      "transferOwnership(address)",
      "to another account",
      fx.redeemer.write.transferOwnership(
        [fx.alice.account.address],
        asOwner(fx),
      ),
    );
  }
  {
    const fx = await freshPoints();
    await tx(
      await viem.getPublicClient(),
      at("PointsRedeemer", fx.redeemer.address, GROUP.admin),
      "renounceOwnership()",
      "current owner",
      fx.redeemer.write.renounceOwnership(asOwner(fx)),
    );
  }
}

describe("Collateral margin gas benchmark", () => {
  it("records grouped receipt gas, view estimates, and complete ABI coverage", async () => {
    await benchmarkVault();
    await benchmarkMarginEngine();
    await benchmarkPoints();

    const measurements = [];
    for (const name of Object.keys(CONTRACTS) as ContractName[]) {
      const snapshot = recorders[name].snapshot();
      assertAbiFunctionCoverage(
        CONTRACTS[name] as unknown as readonly AbiItem[],
        snapshot,
        exclusions[name],
      );
      measurements.push(...snapshot.measurements);
    }
    const version = recorders.CollateralVault.snapshot().version;

    await mkdir(fileURLToPath(new URL("../../benchmarks", import.meta.url)), {
      recursive: true,
    });
    await writeSnapshot(SNAPSHOT_PATH, { version, measurements });
  });
});
