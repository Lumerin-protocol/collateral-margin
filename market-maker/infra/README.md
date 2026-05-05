# Market-maker infra reference

The market-maker now ships as a **single Docker image** with two
entrypoints selected via the `MAKER_APP` environment variable. Each
venue runs as its own ECS service with its own wallet, RPC URL, and
config file.

```
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│ ECS service: market-maker-perps    │      │ ECS service: market-maker-futures  │
│   image:    titan-market-maker:sha │      │   image:    titan-market-maker:sha │
│   env:      MAKER_APP=perps        │      │   env:      MAKER_APP=futures      │
│             MAKER_CONFIG=/configs/perps.yml │             MAKER_CONFIG=/configs/futures.yml │
│   secrets:  PRIVATE_KEY (perps)    │      │   secrets:  PRIVATE_KEY (futures)  │
│             ETH_NODE_ADDRESS       │      │             ETH_NODE_ADDRESS       │
│             PERPS_ADDRESS          │      │             FUTURES_ADDRESS        │
└────────────────────────────────────┘      └────────────────────────────────────┘
```

The two services share **nothing at runtime** — separate ECS task
defs, separate wallets, separate logs. They only share the image so a
single `docker push` rolls both venues forward (each can still be
pinned to a different image tag).

## Files

* `ecs-task.tf` — reusable Terraform module template for one MM service.
  Drop this into both the `perps/.bedrock/.terragrunt/` and
  `futures-marketplace/.bedrock/.terragrunt/` folders, parameterised
  per-venue.

## Migration notes

### Perps repo (`perps/`)

The existing perps MM is already an ECS service. Replace the legacy
task definition (which pointed at the in-repo `market-maker/`
TypeScript) with one that uses:

* image: `ghcr.io/lumerin-protocol/titan-market-maker:<sha>`
* env: `MAKER_APP=perps`
* env: `MAKER_CONFIG=/app/configs/perps.yml`
* secrets: `PRIVATE_KEY` from Secrets Manager (per-venue secret)

Then delete the in-repo `perps/market-maker/` and its
`.github/workflows/{deploy-market-maker,market-maker-tests}.yml`.

### Futures-marketplace repo (`futures-marketplace/`)

The existing futures MM is a **Lambda** (see
`futures-marketplace/.bedrock/.terragrunt/10_market_maker_lambda.tf`).
The new MM is a long-running process — a Lambda doesn't fit. Replace
the entire `10_market_maker_lambda.tf` with an ECS service definition
based on `ecs-task.tf` here. Reuse the existing
`aws_secretsmanager_secret.market_maker` (rename if desired).

Then delete the in-repo `futures-marketplace/market-maker/` and its
`.github/workflows/{deploy-market-maker,test-market-maker}.yml`.

## Image build

CI in `collateral-margin/.github/workflows/` builds and pushes the
shared image. Both repos consume it via image tag (sha-pinned). No
cross-repo build coordination needed.
