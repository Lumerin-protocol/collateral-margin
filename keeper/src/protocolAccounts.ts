import { getAddress, type Address } from "viem";

/**
 * Keyless vanity accounts the vault uses as ledgers. They show up in the same
 * events as real users (vault `Transfer`, venue `OrderMatched` with the backstop
 * as taker) but must never be liquidated or margin-checked:
 *
 *   - `INSURANCE_FUND_ADDR` is the implicit clearing counterparty for every PnL
 *     transfer.
 *   - `BACKSTOP_ADDR` holds the positions liquidation hands off. It is reduced
 *     through the permissionless `unwindBackstop` (see `backstop/unwinder.ts`)
 *     and cash-settled at expiry like any other futures leg.
 *
 * Both are `constant`s on `CollateralVault`, so the keeper hard-codes them
 * rather than paying an RPC read at boot.
 */
export const INSURANCE_FUND_ADDR: Address = getAddress(
  "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
);
export const BACKSTOP_ADDR: Address = getAddress(
  "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
);

const PROTOCOL_ACCOUNTS = new Set<string>([
  INSURANCE_FUND_ADDR.toLowerCase(),
  BACKSTOP_ADDR.toLowerCase(),
]);

/** True for the vault's vanity ledgers — never a liquidation candidate. */
export function isProtocolAccount(user: Address): boolean {
  return PROTOCOL_ACCOUNTS.has(user.toLowerCase());
}
