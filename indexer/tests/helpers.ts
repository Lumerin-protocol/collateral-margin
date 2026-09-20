/**
 * Deterministic test data generators and event param helpers.
 * AssemblyScript has no Math.random, so we use seeds for reproducible, meaningful IDs.
 */
import { Address, BigInt, Bytes, DataSourceContext, ethereum, Value } from "@graphprotocol/graph-ts";
import { dataSourceMock } from "matchstick-as/assembly/index";
import { Vault } from "../generated/schema";

function padLeft(s: string, len: i32, char: string): string {
  while (s.length < len) {
    s = char + s;
  }
  return s;
}

/** Deterministic address from numeric id. e.g. userAddress(1) => 0x00...01 */
export function userAddress(id: i32): Address {
  const hex = padLeft(id.toString(16), 40, "0");
  return Address.fromString("0x" + hex);
}

export const VAULT_ADDRESS = userAddress(255);
// Stand-in engine addresses used for the data-source `context` in tests; mirror
// what subgraph.template.yaml injects from the env in production.
export const PERPS_ADDRESS = userAddress(101);
export const OPTIONS_ADDRESS = userAddress(102);

/**
 * Mock both `dataSource.address()` and `dataSource.context()` so handlers can
 * resolve the perps/options addresses passed in by the manifest's `context`
 * block. Call from every `beforeEach`.
 */
export function setupDataSourceMock(): void {
  const ctx = new DataSourceContext();
  ctx.set("perpsAddress", Value.fromString(PERPS_ADDRESS.toHexString()));
  ctx.set("optionsAddress", Value.fromString(OPTIONS_ADDRESS.toHexString()));
  dataSourceMock.setAddressAndContext(VAULT_ADDRESS.toHexString(), ctx);
}

export const INSURANCE_FUND_ADDRESS = Address.fromString(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);

// ── ethereum.EventParam helpers ─────────────────────────────────────────────

export function paramAddr(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value));
}

export function paramUint(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value));
}

export function paramInt64(name: string, value: i64): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(value)));
}

export function paramBool(name: string, value: boolean): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBoolean(value));
}

export function paramBytes(name: string, value: Bytes): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBytes(value));
}

/**
 * Pre-create the Vault singleton so handlers don't trigger `loadVaultFromContract`,
 * which would attempt unmocked contract calls. Matchstick can't execute those.
 */
export function setupVault(): void {
  const vault = new Vault("0");
  vault.contractAddress = changetype<Bytes>(VAULT_ADDRESS);
  vault.collateralToken = Bytes.empty();
  vault.marginEngine = Bytes.empty();
  vault.insuranceFundAddress = Bytes.empty();
  vault.decimals = 6;
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
  vault.save();
}
