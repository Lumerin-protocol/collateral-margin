# Vault Indexer

A Graph Protocol subgraph that indexes the `CollateralVault` contract — turning on-chain events into a queryable GraphQL API for collateral balances, deposit / withdrawal history, and PnL flows attributable to each product engine (perps, options, …).

It is the **single source of truth for vault state**. Product subgraphs (`perps`, `options`, …) intentionally do **not** track collateral and instead rely on this subgraph for any user-balance / deposit-history queries.

## Schema

### Entities

| Entity | Mutability | Description |
| --- | --- | --- |
| **Vault** | mutable | Singleton (id=0). Contract identity, lifetime aggregates, and current `totalSupply` / `insuranceFundBalance`. |
| **VaultUser** | mutable | Per-address account: current `balance`, lifetime deposit / withdrawal totals, and signed net of internal transfers (overall + per caller-category). |
| **VaultDeposit** | immutable | One per `Deposited` event. Tracks recipient, amount, and the funding `sender`. `isInsuranceFund` distinguishes `depositInsuranceFund` flow. |
| **VaultWithdrawal** | immutable | One per `Withdrawn` event. Tracks owner, recipient, amount. `isInsuranceFund` distinguishes `withdrawInsuranceFund` flow. |
| **VaultInternalTransfer** | immutable | One per `Transfer` event with `from != 0x0 && to != 0x0` (i.e. `internalTransfer` / `internalTransferWithMarginCheck`). Tagged with a `callerCategory` derived from `transaction.to`. |

### Caller attribution

`internalTransfer` does not emit which engine called it. As a heuristic, the indexer compares `transaction.to` against the configured `PERPS_ADDRESS` / `OPTIONS_ADDRESS` (from `.env`):

| transaction.to | callerCategory |
| --- | --- |
| `PERPS_ADDRESS` | `PERPS` |
| `OPTIONS_ADDRESS` | `OPTIONS` |
| anything else | `OTHER` |

This is accurate for "EOA → engine → vault" flows, which is the dominant pattern. A multi-hop tx (router → engine → vault) would land in `OTHER`. If you need exact attribution add a richer event to the contract.

### Event handlers

| Event | What it does |
| --- | --- |
| `Initialized(uint64)` | Bootstraps the `Vault` singleton (collateral-token, margin-engine, decimals). |
| `Transfer(address,address,uint256)` | **Single source of truth for balances**: mint = deposit, burn = withdrawal, internal = `VaultInternalTransfer`. Updates `VaultUser.balance`, `Vault.totalSupply`, `Vault.insuranceFundBalance`, and signed `netInternalIn` / `netFrom*` totals. |
| `Deposited(address,uint256,address)` | Creates the `VaultDeposit` entity and bumps `VaultUser` / `Vault` deposit aggregates. |
| `Withdrawn(address,uint256,address)` | Creates the `VaultWithdrawal` entity and bumps `VaultUser` / `Vault` withdrawal aggregates. |
| `InsuranceFundDeposited(address,uint256)` | Bumps `Vault.insuranceFundDeposited`. (The actual `VaultDeposit` entity is created by the paired `Deposited` event with `isInsuranceFund = true`.) |
| `InsuranceFundWithdrawn(address,uint256)` | Bumps `Vault.insuranceFundWithdrawn`. |

### Why both `Transfer` and `Deposited` / `Withdrawn`?

`CollateralVault` extends `ERC20Upgradeable` but disables the public ERC20 surface. All balance changes still flow through `_mint` / `_burn` / `_transfer`, which emit `Transfer`. Using `Transfer` as the balance ledger is lossless and trivially correct. The `Deposited` / `Withdrawn` events carry semantic context that `Transfer` does not (the funding `sender` and the withdrawal `recipient`), so we keep them as **entity-creation handlers** while delegating balance math entirely to `Transfer`.

## Local Development

### Prerequisites

- Docker (for graph-node, IPFS, and Postgres)
- pnpm
- An Ethereum node URL for graph-node to connect to

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
NETWORK=arbitrum-sepolia
VAULT_ADDRESS=0x...
VAULT_START_BLOCK=123456
PERPS_ADDRESS=0x...
OPTIONS_ADDRESS=0x...
ETH_NODE_ADDRESS=https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY
```

`PERPS_ADDRESS` / `OPTIONS_ADDRESS` are injected into the data source `context` block in `subgraph.yaml` via `envsubst` and read at runtime via `dataSource.context()`, so re-run `pnpm prepare-local` if you change them.

### 2. Start infrastructure

```bash
pnpm indexer   # docker-compose up (graph-node + IPFS + Postgres)
```

### 3. Build and deploy

```bash
pnpm setup-local
```

Or step by step:

```bash
pnpm prepare-local    # Substitute env vars into subgraph.yaml
pnpm codegen          # Generate AssemblyScript types from schema + ABI
pnpm build            # Compile the subgraph
pnpm create-local     # Register subgraph name with graph-node
pnpm deploy-local     # Deploy to local graph-node
```

### 4. Query

```
http://localhost:8000/subgraphs/name/collateral-vault
```

## Available Scripts

| Script | Description |
| --- | --- |
| `pnpm indexer` | Start graph-node + IPFS + Postgres via Docker Compose |
| `pnpm setup-local` | Full local pipeline: prepare, codegen, build, create, deploy |
| `pnpm prepare-local` | Substitute `.env` vars into `subgraph.yaml` |
| `pnpm codegen` | Generate AssemblyScript types |
| `pnpm build` | Compile the subgraph |
| `pnpm create-local` | Register subgraph with local graph-node |
| `pnpm deploy-local` | Deploy subgraph to local graph-node |
| `pnpm remove-local` | Remove subgraph from local graph-node |
| `pnpm deploy` | Deploy to The Graph Studio (hosted) |
| `pnpm test` | Run Matchstick unit tests |
| `pnpm clean` | Remove generated files, build artifacts, and data |

## Configuration

The subgraph manifest is generated from `subgraph.template.yaml` using `envsubst` from the parent `.env`. Recognised template vars:

| Var | Used by | Notes |
| --- | --- | --- |
| `NETWORK` | manifest, docker-compose | e.g. `arbitrum-sepolia` |
| `VAULT_ADDRESS` | manifest | Deployed `CollateralVault` proxy address |
| `VAULT_START_BLOCK` | manifest | First block to index |
| `PERPS_ADDRESS` | manifest `context` | Used to bucket internal transfers |
| `OPTIONS_ADDRESS` | manifest `context` | Used to bucket internal transfers |
| `ETH_NODE_ADDRESS` | docker-compose | RPC endpoint for graph-node |

The ABI is read from `../contracts/abi/CollateralVault.json`, so the contracts package must be built (`pnpm -C contracts compile`) before running `pnpm codegen`.

## Example Queries

**Vault stats:**

```graphql
{
  vault(id: 0) {
    totalDeposited
    totalWithdrawn
    totalSupply
    insuranceFundBalance
    insuranceFundDeposited
    insuranceFundWithdrawn
    totalUsers
    depositCount
    withdrawalCount
    internalTransferCount
  }
}
```

**User portfolio:**

```graphql
{
  vaultUser(id: "0x...") {
    balance
    totalDeposited
    totalWithdrawn
    netFromPerps
    netFromOptions
    netInternalIn
  }
}
```

**Deposit history:**

```graphql
{
  vaultDeposits(
    where: { user: "0x..." }
    orderBy: timestamp
    orderDirection: desc
    first: 50
  ) {
    amount
    sender
    isInsuranceFund
    timestamp
    transactionHash
  }
}
```

**Internal transfers attributed to perps (e.g. PnL settlement timeline):**

```graphql
{
  vaultInternalTransfers(
    where: { callerCategory: PERPS }
    orderBy: timestamp
    orderDirection: desc
    first: 50
  ) {
    from { address }
    to   { address }
    amount
    timestamp
    transactionHash
  }
}
```

**Top recipients of perps-bucketed flow:**

```graphql
{
  vaultUsers(first: 10, orderBy: netFromPerps, orderDirection: desc) {
    address
    netFromPerps
    netInternalIn
    balance
  }
}
```
