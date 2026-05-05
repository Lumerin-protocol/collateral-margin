#!/usr/bin/env bash
# Copy canonical ABIs from the three contract repos into market-maker.
#
# The three sources of truth:
#   collateral-margin/contracts        → CollateralVault, PortfolioMarginEngine
#   ../perps/contracts                 → HashPowerPerpsDEX
#   ../futures-marketplace/contracts   → Futures
#
# The MM never imports from those repos directly — running this script (via
# `pnpm pretest`) keeps a vendored copy under src/abi.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CM_CONTRACTS="$(cd "$ROOT/../contracts" && pwd)"
PERPS_CONTRACTS="$(cd "$ROOT/../../perps/contracts" 2>/dev/null && pwd || true)"
FUTURES_CONTRACTS="$(cd "$ROOT/../../futures-marketplace/contracts" 2>/dev/null && pwd || true)"

cd "$CM_CONTRACTS" && pnpm hardhat compile >/dev/null
[[ -n "${PERPS_CONTRACTS:-}" ]]   && (cd "$PERPS_CONTRACTS"   && pnpm hardhat compile >/dev/null)
[[ -n "${FUTURES_CONTRACTS:-}" ]] && (cd "$FUTURES_CONTRACTS" && pnpm hardhat compile >/dev/null)

mkdir -p "$ROOT/src/abi"

cp "$CM_CONTRACTS/abi/CollateralVault.ts"        "$ROOT/src/abi/CollateralVault.ts"
cp "$CM_CONTRACTS/abi/PortfolioMarginEngine.ts"  "$ROOT/src/abi/PortfolioMarginEngine.ts"

if [[ -n "${PERPS_CONTRACTS:-}" ]]; then
  cp "$PERPS_CONTRACTS/abi/HashPowerPerpsDEX.ts" "$ROOT/src/abi/HashPowerPerpsDEX.ts"
  cp "$PERPS_CONTRACTS/abi/Multicall3.ts"        "$ROOT/src/abi/Multicall3.ts"
fi

if [[ -n "${FUTURES_CONTRACTS:-}" ]]; then
  cp "$FUTURES_CONTRACTS/abi/Futures.ts" "$ROOT/src/abi/Futures.ts"
fi

echo "ABIs synced to $ROOT/src/abi/"
