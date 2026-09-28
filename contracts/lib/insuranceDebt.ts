import { zeroAddress } from "viem";

/** On-chain insurance-debt snapshot printed by the cap and halt scripts. */
export async function readInsuranceDebtState(vault: {
  read: {
    insuranceDebtCap: () => Promise<bigint>;
    insuranceDebt: () => Promise<bigint>;
    uncoveredLoss: () => Promise<bigint>;
    timingDebt: () => Promise<bigint>;
    insuranceCapital: () => Promise<bigint>;
    insuranceFundBalance: () => Promise<bigint>;
    halted: () => Promise<boolean>;
    marginEngine: () => Promise<string>;
    effectiveInsuranceDebtCap: () => Promise<bigint>;
  };
}) {
  const [cap, debt, uncovered, timing, capital, fund, halted, marginEngine, effectiveCap] =
    await Promise.all([
      vault.read.insuranceDebtCap(),
      vault.read.insuranceDebt(),
      vault.read.uncoveredLoss(),
      vault.read.timingDebt(),
      vault.read.insuranceCapital(),
      vault.read.insuranceFundBalance(),
      vault.read.halted(),
      vault.read.marginEngine(),
      vault.read.effectiveInsuranceDebtCap(),
    ]);
  return {
    cap,
    debt,
    uncovered,
    timing,
    capital,
    fund,
    halted,
    marginEngine,
    effectiveCap,
    engineUnset: marginEngine.toLowerCase() === zeroAddress,
  };
}
