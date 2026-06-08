/**
 * Deterministic test data generators and event param helpers.
 * AssemblyScript has no Math.random, so we use seeds for reproducible, meaningful IDs.
 */
import { Address, BigInt, Bytes, DataSourceContext, ethereum } from "@graphprotocol/graph-ts";
import { dataSourceMock } from "matchstick-as/assembly/index";

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

export const POINTS_ADDRESS = userAddress(255);
export const HOOK_ADDRESS = userAddress(254);
export const REDEEMER_ADDRESS = userAddress(253);

/**
 * Point `dataSource.address()` at one of the points contracts. The handlers all
 * live in one mapping file, so set the address that matches the event under test.
 */
export function mockDataSource(address: Address): void {
  dataSourceMock.setAddressAndContext(address.toHexString(), new DataSourceContext());
}

// ── ethereum.EventParam helpers ─────────────────────────────────────────────

export function paramAddr(name: string, value: Address): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromAddress(value));
}

export function paramUint(name: string, value: BigInt): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromUnsignedBigInt(value));
}

export function paramBool(name: string, value: boolean): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBoolean(value));
}

export function paramBytes(name: string, value: Bytes): ethereum.EventParam {
  return new ethereum.EventParam(name, ethereum.Value.fromBytes(value));
}
