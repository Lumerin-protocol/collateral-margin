import { Address, BigInt, Bytes, dataSource, log } from "@graphprotocol/graph-ts";
import {
  CollateralVault as VaultContract,
  Deposited,
  Initialized,
  InsuranceFundDeposited,
  InsuranceFundWithdrawn,
  Transfer,
  Withdrawn,
} from "../generated/CollateralVault/CollateralVault";
import {
  Vault,
  VaultDeposit,
  VaultInternalTransfer,
  VaultUser,
  VaultWithdrawal,
} from "../generated/schema";
import { createEventId } from "./ids";

// ── Constants ───────────────────────────────────────────────────────────────

const ZERO_ADDRESS = Address.zero();
// Must mirror CollateralVault.INSURANCE_FUND_ADDR — kept in sync because the
// vault constant is fully deterministic (no init dependency) so we don't have
// to refetch it from the contract on every event.
// The on-chain literal is mixed-case (`0xaAaA…aaAa`) for EIP-55 styling, but
// graph-ts/matchstick can mis-parse non-canonical casing, so we use lowercase.
const INSURANCE_FUND_ADDR = Address.fromString("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

// CallerCategory enum string values (must match schema.graphql).
const CATEGORY_PERPS = "PERPS";
const CATEGORY_OPTIONS = "OPTIONS";
const CATEGORY_OTHER = "OTHER";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the perps/options engine addresses from `dataSource.context()`.
 * Populated from environment variables via subgraph.template.yaml. Tests must
 * call `dataSourceMock.setContext(ctx)` to seed these.
 */
function knownCallers(): Address[] {
  const ctx = dataSource.context();
  return [
    Address.fromString(ctx.mustGet("perpsAddress").toString()),
    Address.fromString(ctx.mustGet("optionsAddress").toString()),
  ];
}

function categoryOf(caller: Bytes): string {
  const known = knownCallers();
  if (caller.equals(known[0])) return CATEGORY_PERPS;
  if (caller.equals(known[1])) return CATEGORY_OPTIONS;
  return CATEGORY_OTHER;
}

function getOrCreateVault(): Vault {
  let vault = Vault.load("0");
  if (!vault) {
    vault = new Vault("0");
    vault.contractAddress = dataSource.address();
    vault.collateralToken = Bytes.empty();
    vault.marginEngine = Bytes.empty();
    vault.insuranceFundAddress = INSURANCE_FUND_ADDR;
    vault.decimals = 0;
    vault.totalDeposited = BigInt.zero();
    vault.totalWithdrawn = BigInt.zero();
    vault.insuranceFundDeposited = BigInt.zero();
    vault.insuranceFundWithdrawn = BigInt.zero();
    vault.totalSupply = BigInt.zero();
    vault.insuranceFundBalance = BigInt.zero();
    vault.totalUsers = 0;
    vault.depositCount = 0;
    vault.withdrawalCount = 0;
    vault.internalTransferCount = 0;
    vault.initializedAt = BigInt.zero();
    vault.lastUpdatedAt = BigInt.zero();
    // Don't `loadVaultFromContract` here — that read happens lazily via
    // `handleInitialized`. Calling it here would fail in matchstick (no mocks).
  }
  return vault;
}

function loadVaultFromContract(vault: Vault): void {
  const contract = VaultContract.bind(dataSource.address());

  const collateralToken = contract.try_collateralToken();
  if (!collateralToken.reverted) {
    vault.collateralToken = collateralToken.value;
  }

  const marginEngine = contract.try_marginEngine();
  if (!marginEngine.reverted) {
    vault.marginEngine = marginEngine.value;
  }

  const decimals = contract.try_decimals();
  if (!decimals.reverted) {
    vault.decimals = decimals.value;
  }
}

/**
 * Returns the user entity, creating it on first sight. Pair with `bumpUserCountIfNew`
 * when you also need to increment `Vault.totalUsers` — separating the two keeps this
 * helper safely callable from contexts that are still mid-flight on the Vault entity.
 */
function getOrCreateVaultUser(address: Address, timestamp: BigInt): VaultUser {
  let user = VaultUser.load(address);
  if (!user) {
    user = new VaultUser(address);
    user.address = address;
    user.balance = BigInt.zero();
    user.totalDeposited = BigInt.zero();
    user.totalWithdrawn = BigInt.zero();
    user.netInternalIn = BigInt.zero();
    user.netFromPerps = BigInt.zero();
    user.netFromOptions = BigInt.zero();
    user.netFromOther = BigInt.zero();
    user.depositCount = 0;
    user.withdrawalCount = 0;
    user.createdAt = timestamp;
    user.lastActivityAt = timestamp;
  }
  return user;
}

function bumpUserCount(vault: Vault, isNewUser: boolean): void {
  if (isNewUser) vault.totalUsers++;
}

/**
 * Apply a signed delta to a user's combined `netInternalIn` and the matching
 * per-category bucket. `delta` is negative for the sender, positive for the
 * receiver. Skips silently if the user entity doesn't exist (shouldn't happen
 * in normal flows, but matches the prior null-safe behavior).
 */
function bumpCategoryNet(address: Address, category: string, delta: BigInt): void {
  const user = VaultUser.load(address);
  if (!user) return;
  user.netInternalIn = user.netInternalIn.plus(delta);
  if (category == CATEGORY_PERPS) {
    user.netFromPerps = user.netFromPerps.plus(delta);
  } else if (category == CATEGORY_OPTIONS) {
    user.netFromOptions = user.netFromOptions.plus(delta);
  } else {
    user.netFromOther = user.netFromOther.plus(delta);
  }
  user.save();
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function handleInitialized(event: Initialized): void {
  log.info("CollateralVault initialized: version {}", [event.params.version.toString()]);

  const vault = getOrCreateVault();
  vault.initializedAt = event.block.timestamp;
  vault.lastUpdatedAt = event.block.timestamp;
  loadVaultFromContract(vault);
  vault.save();
}

// ── Transfer (the single source of truth for balances) ─────────────────────
//
// CollateralVault inherits from ERC20Upgradeable, but its public ERC20 surface
// (`approve`, `transfer`, `transferFrom`) is hard-disabled. Transfer events
// only ever come from internal `_mint` / `_burn` / `_transfer`:
//   - mint  (from = 0x0)  ⇢ paired with `Deposited`
//   - burn  (to   = 0x0)  ⇢ paired with `Withdrawn`
//   - internal transfer    ⇢ from `internalTransfer` / `internalTransferWithMarginCheck`
// That makes Transfer a complete, lossless balance ledger.
export function handleTransfer(event: Transfer): void {
  const from = event.params.from;
  const to = event.params.to;
  const amount = event.params.value;

  const isMint = from.equals(ZERO_ADDRESS);
  const isBurn = to.equals(ZERO_ADDRESS);
  const vault = getOrCreateVault();

  if (!isMint) {
    const isNew = VaultUser.load(from) === null;
    const fromUser = getOrCreateVaultUser(from, event.block.timestamp);
    fromUser.balance = fromUser.balance.minus(amount);
    fromUser.lastActivityAt = event.block.timestamp;
    fromUser.save();
    bumpUserCount(vault, isNew);
  } else {
    vault.totalSupply = vault.totalSupply.plus(amount);
  }

  if (!isBurn) {
    const isNew = VaultUser.load(to) === null;
    const toUser = getOrCreateVaultUser(to, event.block.timestamp);
    toUser.balance = toUser.balance.plus(amount);
    toUser.lastActivityAt = event.block.timestamp;
    toUser.save();
    bumpUserCount(vault, isNew);
  } else {
    vault.totalSupply = vault.totalSupply.minus(amount);
  }

  if (from.equals(INSURANCE_FUND_ADDR)) {
    vault.insuranceFundBalance = vault.insuranceFundBalance.minus(amount);
  }
  if (to.equals(INSURANCE_FUND_ADDR)) {
    vault.insuranceFundBalance = vault.insuranceFundBalance.plus(amount);
  }

  if (!isMint && !isBurn) {
    // Internal transfer between two real accounts (PnL settlement, fees, etc.).
    // `event.transaction.to` is `Bytes | null`; if null we treat it as OTHER.
    const txTo = event.transaction.to;
    const callerBytes: Bytes = txTo !== null ? (txTo as Bytes) : Bytes.empty();
    const category = categoryOf(callerBytes);

    const transferId = createEventId(event.transaction.hash, event.logIndex);
    const transfer = new VaultInternalTransfer(transferId);
    transfer.from = from;
    transfer.to = to;
    transfer.amount = amount;
    transfer.caller = callerBytes;
    transfer.callerCategory = category;
    transfer.timestamp = event.block.timestamp;
    transfer.blockNumber = event.block.number;
    transfer.transactionHash = event.transaction.hash;
    transfer.save();

    bumpCategoryNet(from, category, amount.neg());
    bumpCategoryNet(to, category, amount);

    vault.internalTransferCount++;
  }

  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

// ── Deposit ─────────────────────────────────────────────────────────────────

export function handleDeposited(event: Deposited): void {
  const recipient = event.params.user;
  const amount = event.params.amount;
  const sender = event.params.sender;
  const isInsuranceFund = recipient.equals(INSURANCE_FUND_ADDR);

  log.info("Deposited: recipient {} amount {} sender {} insuranceFund {}", [
    recipient.toHexString(),
    amount.toString(),
    sender.toHexString(),
    isInsuranceFund ? "true" : "false",
  ]);

  const isNewUser = VaultUser.load(recipient) === null;
  const user = getOrCreateVaultUser(recipient, event.block.timestamp);
  user.totalDeposited = user.totalDeposited.plus(amount);
  user.depositCount++;
  user.lastActivityAt = event.block.timestamp;
  user.save();

  const id = createEventId(event.transaction.hash, event.logIndex);
  const deposit = new VaultDeposit(id);
  deposit.user = user.id;
  deposit.sender = sender;
  deposit.amount = amount;
  deposit.isInsuranceFund = isInsuranceFund;
  deposit.timestamp = event.block.timestamp;
  deposit.blockNumber = event.block.number;
  deposit.transactionHash = event.transaction.hash;
  deposit.save();

  const vault = getOrCreateVault();
  if (!isInsuranceFund) {
    vault.totalDeposited = vault.totalDeposited.plus(amount);
    vault.depositCount++;
  }
  bumpUserCount(vault, isNewUser);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

// ── Withdraw ────────────────────────────────────────────────────────────────

export function handleWithdrawn(event: Withdrawn): void {
  const owner = event.params.user;
  const amount = event.params.amount;
  const recipient = event.params.recipient;
  const isInsuranceFund = owner.equals(INSURANCE_FUND_ADDR);

  log.info("Withdrawn: owner {} amount {} recipient {} insuranceFund {}", [
    owner.toHexString(),
    amount.toString(),
    recipient.toHexString(),
    isInsuranceFund ? "true" : "false",
  ]);

  const isNewUser = VaultUser.load(owner) === null;
  const user = getOrCreateVaultUser(owner, event.block.timestamp);
  user.totalWithdrawn = user.totalWithdrawn.plus(amount);
  user.withdrawalCount++;
  user.lastActivityAt = event.block.timestamp;
  user.save();

  const id = createEventId(event.transaction.hash, event.logIndex);
  const withdrawal = new VaultWithdrawal(id);
  withdrawal.user = user.id;
  withdrawal.recipient = recipient;
  withdrawal.amount = amount;
  withdrawal.isInsuranceFund = isInsuranceFund;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.transactionHash = event.transaction.hash;
  withdrawal.save();

  const vault = getOrCreateVault();
  if (!isInsuranceFund) {
    vault.totalWithdrawn = vault.totalWithdrawn.plus(amount);
    vault.withdrawalCount++;
  }
  bumpUserCount(vault, isNewUser);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

// ── Insurance fund (paired markers; primary entities are created via Deposited/Withdrawn) ─

export function handleInsuranceFundDeposited(event: InsuranceFundDeposited): void {
  log.info("InsuranceFundDeposited: source {} amount {}", [
    event.params.source.toHexString(),
    event.params.amount.toString(),
  ]);

  const vault = getOrCreateVault();
  vault.insuranceFundDeposited = vault.insuranceFundDeposited.plus(event.params.amount);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

export function handleInsuranceFundWithdrawn(event: InsuranceFundWithdrawn): void {
  log.info("InsuranceFundWithdrawn: recipient {} amount {}", [
    event.params.recipient.toHexString(),
    event.params.amount.toString(),
  ]);

  const vault = getOrCreateVault();
  vault.insuranceFundWithdrawn = vault.insuranceFundWithdrawn.plus(event.params.amount);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}
