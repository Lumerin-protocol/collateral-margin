# collateral-margin

Deployable Solidity for **unified collateral custody** and **cross-product portfolio margin** (perps, options, futures, and other integrators that share the same vault and risk surface).

## Contents

| Area | Contracts |
| ---- | --------- |

| Custody | `CollateralVault` (UUPS upgradeable receipt token + authorized engine transfers) |
| Risk | `PortfolioMarginEngine` (scenario-based portfolio IM/MM) |
| Integration | `ICollateralVault`, `IPortfolioMarginEngine`, `IHashPowerPerpsDEX`, `IOptionsEnginePortfolioView` |
| Tests | Mocks under `contracts/contracts/mocks/` (`USDCMock`, `PerpsDEXMock`, `OptionsEngineMock`, …) |

## Repo layout

- **Repository root** — npm package `collateral-margin` (used as `file:../collateral-margin` from other repos).
- **`contracts/`** — Hardhat 3 project (`collateral-margin-contracts`): sources live in **`contracts/contracts/*.sol`** (standard Hardhat `contracts` directory nested inside the package folder).

## Development

From the Hardhat package:

```bash
cd contracts
pnpm install
pnpm test
pnpm run build    # compile + export TypeScript ABIs under contracts/abi/
pnpm run clean    # remove abi, artifacts, cache
```

Requirements: Node 24.x (see `contracts/package.json`).

## Consuming from another repo

Add the dependency (path adjusted to your monorepo layout):

```json
"collateral-margin": "file:../../collateral-margin"
```

Import interfaces and sources from **`collateral-margin/contracts/contracts/...`** (first `contracts` = this repo’s Hardhat folder, second = Hardhat’s sources root), for example:

```solidity
import { ICollateralVault } from "collateral-margin/contracts/contracts/interfaces/ICollateralVault.sol";
```

If you use Hardhat, list the same paths in `npmFilesToBuild` (or your compiler’s equivalent) for any `.sol` files pulled from this package.

## License

MIT (see `contracts/package.json`; root `package.json` is a thin workspace stub).
