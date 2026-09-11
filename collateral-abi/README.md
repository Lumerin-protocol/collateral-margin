# @hashpower/collateral-abi

ABIs and deployment addresses for the Hashpower unified collateral system on Base:

| Contract | Purpose |
| --- | --- |
| `CollateralVault` | Shared USDC custody — `deposit`, `withdraw` (IM-gated), `balanceOf` |
| `PortfolioMarginEngine` | Cross-product portfolio margin — `computePortfolioIM/MM`, `isHealthy`, `canPlaceOrder` |
| `Points` | Rewards ledger |

Collateral is unified across all Hashpower trading venues (futures, perps): deposit once to the vault, trade everywhere. Withdrawals are gated by portfolio initial margin.

## Usage

```ts
import { CollateralVaultAbi, PortfolioMarginEngineAbi } from "@hashpower/collateral-abi";
import deployments from "@hashpower/collateral-abi/deployments.json" with { type: "json" };

// "testnet" (Base Sepolia) or "mainnet" (Base)
const env = process.env.HASHPOWER_ENV ?? "testnet";
const { contracts } = deployments.environments[env];

const im = await client.readContract({
  address: contracts.PortfolioMarginEngine,
  abi: PortfolioMarginEngineAbi,
  functionName: "computePortfolioIM",
  args: [account],
});
```

Raw JSON ABIs (for subgraphs and non-TypeScript consumers) are available under `@hashpower/collateral-abi/json/<Contract>.json`.

## How this package is built

Contents are generated — do not edit by hand:

- `src/` is copied from `../contracts/abi` (the Hardhat codegen output) by `scripts/build.mjs`, then compiled to `dist/`.
- `deployments.json` is the canonical address manifest for this repo; it is updated when contracts are (re)deployed.

Publishing happens automatically from CI when ABIs or the manifest change (see `.github/workflows/publish-collateral-abi.yml`).
