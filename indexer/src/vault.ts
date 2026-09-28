import { Address, BigInt, Bytes, dataSource, log } from "@graphprotocol/graph-ts";
import {
  BadDebt,
  CollateralVault as VaultContract,
  Deposited,
  Initialized,
  InsuranceDebtBorrowed,
  InsuranceDebtCapSet,
  InsuranceDebtRepaid,
  InsuranceFundDeposited,
  InsuranceFundWithdrawn,
  MarginEngineSet,
  Transfer,
  VaultHalted,
  VaultResumed,
  Withdrawn,
} from "../generated/CollateralVault/CollateralVault";
import {
  BadDebtEvent,
  InsuranceDebtCapChange,
  InsuranceDebtEvent,
  Vault,
  VaultDeposit,
  VaultHaltEvent,
  VaultInternalTransfer,
  VaultUser,
  VaultVenue,
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

const KIND_RESERVE_LOSS = "RESERVE_LOSS";
const KIND_FEE = "FEE";
const KIND_BORROW = "BORROW";
const KIND_REPAY = "REPAY";
const KIND_HALT = "HALT";
const KIND_RESUME = "RESUME";
const REASON_CAP = "CAP";
const REASON_OWNER = "OWNER";
const REASON_NO_MARGIN_ENGINE = "NO_MARGIN_ENGINE";

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
    vault.insuranceDebt = BigInt.zero();
    vault.insuranceDebtCap = BigInt.zero();
    vault.insuranceDebtBorrowedTotal = BigInt.zero();
    vault.insuranceDebtRepaidTotal = BigInt.zero();
    vault.traderBadDebtTotal = BigInt.zero();
    vault.insuranceCapital = BigInt.zero();
    vault.uncoveredLoss = BigInt.zero();
    vault.timingDebt = BigInt.zero();
    vault.halted = false;
    vault.haltedSince = BigInt.zero();
    vault.insuranceDebtSince = BigInt.zero();
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
 * uncoveredLoss = max(0, traderBadDebtTotal - insuranceCapital)
 * timingDebt = max(0, insuranceDebt - uncoveredLoss)
 * Capital is signed: a negative balance adds to the uncovered loss.
 */
function recomputeDebtSplit(vault: Vault): void {
  let uncovered: BigInt;
  if (vault.insuranceCapital.lt(BigInt.zero())) {
    uncovered = vault.traderBadDebtTotal.plus(vault.insuranceCapital.neg());
  } else if (vault.traderBadDebtTotal.le(vault.insuranceCapital)) {
    uncovered = BigInt.zero();
  } else {
    uncovered = vault.traderBadDebtTotal.minus(vault.insuranceCapital);
  }
  vault.uncoveredLoss = uncovered;
  if (vault.insuranceDebt.le(uncovered)) {
    vault.timingDebt = BigInt.zero();
  } else {
    vault.timingDebt = vault.insuranceDebt.minus(uncovered);
  }
}

function haltReasonName(reason: i32): string {
  if (reason == 1) return REASON_OWNER;
  if (reason == 2) return REASON_NO_MARGIN_ENGINE;
  return REASON_CAP;
}

function getOrCreateVenue(venue: Address): VaultVenue {
  let row = VaultVenue.load(venue);
  if (!row) {
    row = new VaultVenue(venue);
    row.address = venue;
    row.traderBadDebtTotal = BigInt.zero();
    row.feeBadDebtTotal = BigInt.zero();
  }
  return row;
}

function noteDebtOpened(vault: Vault, previous: BigInt, debtAfter: BigInt, timestamp: BigInt): void {
  if (previous.equals(BigInt.zero()) && debtAfter.gt(BigInt.zero())) {
    vault.insuranceDebtSince = timestamp;
  }
  if (debtAfter.equals(BigInt.zero())) {
    vault.insuranceDebtSince = BigInt.zero();
  }
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
  // Version 2 seeds protocol capital from the fund balance already in the vault.
  // Matchstick has no contract, so a reverted read leaves the event-derived value.
  if (event.params.version.equals(BigInt.fromI32(2))) {
    const contract = VaultContract.bind(dataSource.address());
    const capital = contract.try_insuranceCapital();
    if (!capital.reverted) {
      vault.insuranceCapital = capital.value;
      recomputeDebtSplit(vault);
    }
  }
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
  vault.insuranceCapital = vault.insuranceCapital.plus(event.params.amount);
  recomputeDebtSplit(vault);
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
  vault.insuranceCapital = vault.insuranceCapital.minus(event.params.amount);
  recomputeDebtSplit(vault);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

// ── Bad debt and insurance-fund debt ────────────────────────────────────────

export function handleBadDebt(event: BadDebt): void {
  const payer = event.params.payer;
  const receiver = event.params.receiver;
  const amount = event.params.amount;
  const venueAddress = event.params.venue;
  const isReserveLoss = receiver.equals(INSURANCE_FUND_ADDR);

  log.info("BadDebt: payer {} receiver {} amount {} venue {} kind {}", [
    payer.toHexString(),
    receiver.toHexString(),
    amount.toString(),
    venueAddress.toHexString(),
    isReserveLoss ? KIND_RESERVE_LOSS : KIND_FEE,
  ]);

  const isNewUser = VaultUser.load(payer) === null;
  const user = getOrCreateVaultUser(payer, event.block.timestamp);
  user.lastActivityAt = event.block.timestamp;
  user.save();

  const venue = getOrCreateVenue(venueAddress);
  if (isReserveLoss) {
    venue.traderBadDebtTotal = venue.traderBadDebtTotal.plus(amount);
  } else {
    venue.feeBadDebtTotal = venue.feeBadDebtTotal.plus(amount);
  }
  venue.save();

  const row = new BadDebtEvent(createEventId(event.transaction.hash, event.logIndex));
  row.payer = user.id;
  row.receiver = receiver;
  row.amount = amount;
  row.venue = venue.id;
  row.kind = isReserveLoss ? KIND_RESERVE_LOSS : KIND_FEE;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();

  const vault = getOrCreateVault();
  if (isReserveLoss) {
    vault.traderBadDebtTotal = vault.traderBadDebtTotal.plus(amount);
    recomputeDebtSplit(vault);
  }
  bumpUserCount(vault, isNewUser);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}

export function handleInsuranceDebtBorrowed(event: InsuranceDebtBorrowed): void {
  const amount = event.params.amount;
  const debtAfter = event.params.debtAfter;
  const recipient = event.params.to;

  log.info("InsuranceDebtBorrowed: to {} amount {} debtAfter {}", [
    recipient.toHexString(),
    amount.toString(),
    debtAfter.toString(),
  ]);

  const vault = getOrCreateVault();
  const previous = vault.insuranceDebt;
  vault.insuranceDebt = debtAfter;
  vault.insuranceDebtBorrowedTotal = vault.insuranceDebtBorrowedTotal.plus(amount);
  noteDebtOpened(vault, previous, debtAfter, event.block.timestamp);
  recomputeDebtSplit(vault);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();

  // The mint Transfer updates the balance but does not attribute PnL. The borrowed
  // amount is profit paid to this recipient by the calling venue.
  const txTo = event.transaction.to;
  const callerBytes: Bytes = txTo !== null ? (txTo as Bytes) : Bytes.empty();
  bumpCategoryNet(recipient, categoryOf(callerBytes), amount);

  const row = new InsuranceDebtEvent(createEventId(event.transaction.hash, event.logIndex));
  row.kind = KIND_BORROW;
  row.to = recipient;
  row.amount = amount;
  row.debtAfter = debtAfter;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();
}

export function handleInsuranceDebtRepaid(event: InsuranceDebtRepaid): void {
  const amount = event.params.amount;
  const debtAfter = event.params.debtAfter;

  log.info("InsuranceDebtRepaid: amount {} debtAfter {}", [amount.toString(), debtAfter.toString()]);

  const vault = getOrCreateVault();
  const previous = vault.insuranceDebt;
  vault.insuranceDebt = debtAfter;
  vault.insuranceDebtRepaidTotal = vault.insuranceDebtRepaidTotal.plus(amount);
  noteDebtOpened(vault, previous, debtAfter, event.block.timestamp);
  recomputeDebtSplit(vault);
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();

  const row = new InsuranceDebtEvent(createEventId(event.transaction.hash, event.logIndex));
  row.kind = KIND_REPAY;
  row.to = Bytes.empty();
  row.amount = amount;
  row.debtAfter = debtAfter;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();
}

export function handleInsuranceDebtCapSet(event: InsuranceDebtCapSet): void {
  const vault = getOrCreateVault();
  vault.insuranceDebtCap = event.params.newCap;
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();

  const row = new InsuranceDebtCapChange(createEventId(event.transaction.hash, event.logIndex));
  row.oldCap = event.params.oldCap;
  row.newCap = event.params.newCap;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();
}

export function handleVaultHalted(event: VaultHalted): void {
  const vault = getOrCreateVault();
  vault.halted = true;
  vault.haltedSince = event.block.timestamp;
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();

  const row = new VaultHaltEvent(createEventId(event.transaction.hash, event.logIndex));
  row.kind = KIND_HALT;
  row.reason = haltReasonName(event.params.reason);
  row.debt = event.params.debt;
  row.effectiveCap = event.params.effectiveCap;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();
}

export function handleVaultResumed(event: VaultResumed): void {
  const vault = getOrCreateVault();
  vault.halted = false;
  vault.haltedSince = BigInt.zero();
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();

  const row = new VaultHaltEvent(createEventId(event.transaction.hash, event.logIndex));
  row.kind = KIND_RESUME;
  row.debt = event.params.debt;
  row.effectiveCap = event.params.effectiveCap;
  row.timestamp = event.block.timestamp;
  row.blockNumber = event.block.number;
  row.transactionHash = event.transaction.hash;
  row.save();
}

export function handleMarginEngineSet(event: MarginEngineSet): void {
  const vault = getOrCreateVault();
  vault.marginEngine = event.params.marginEngine;
  vault.lastUpdatedAt = event.block.timestamp;
  vault.save();
}
