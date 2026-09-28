########################################
# Service Toggles - SCAFFOLDING ONLY
########################################
# Public runtime config is config/dev.env. Private keys and the Alchemy key
# are Secrets Manager, seeded from gitignored secret.auto.tfvars:
#   alchemy_api_key, liquidator_private_key, futures_mm_private_key,
#   perps_mm_private_key, and optional webhook_secret.
########################################

create_core = true

# Unused. Quoting runs on the futures MM service (portfolio app). create=false
# removes this empty ECS service, its internal ALB, and perpsmm.dev.hashpower.exchange.
perps_mm_service = {
  create          = false
  task_worker_qty = 1 # initial; CI/CD owns desired_count after first deploy
  cnt_port        = 3001
  task_cpu        = 256
  task_ram        = 512
}

# Futures Market Maker - replaces the futures-marketplace lambda. No DNS
# collision (futuresmm.{env}.hashpower.exchange is fresh).
futures_mm_service = {
  create          = true
  task_worker_qty = 1
  cnt_port        = 3001
  task_cpu        = 256
  task_ram        = 512
}

# Unified liquidation keeper (replaces derivatives svc-perps-keeper-dev).
keeper_service = {
  create          = true
  task_worker_qty = 1
  cnt_port        = 3000
  task_cpu        = 256
  task_ram        = 512
}

# Insurance-fund debt. Notifications stay off until the dashboard has been checked.
vault_monitoring = {
  create                   = true
  notifications_enabled    = false
  subgraph_url             = "https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/collateral-vault/dev-latest/gn"
  vault_address            = "0x54A79e2a5C60ACe37b280eBbCda51b4E903d25F0"
  futures_address          = "0x56d8d4a03a0f34b93B86E0b7941aFF29178D0479"
  perps_address            = "0x0d412BC34a48e434144687Aac03b9C593F5237B6"
  rate_minutes             = 5
  debt_util_warn_pct       = 50
  debt_util_crit_pct       = 80
  max_subgraph_age_minutes = 15
  oracle_metric_namespace  = "HashpriceOracle-DEV"
}

########################################
# Account metadata
########################################
provider_profile  = "titanio-dev"
account_shortname = "titanio-dev"
account_number    = "434960487817"
account_lifecycle = "dev"
default_region    = "us-east-1"
region_shortname  = "use1"

########################################
# Environment Specific Variables
########################################
vpc_index            = 1
devops_keypair       = "bedrock-titanio-dev-use1"
titanio_net_edge_vpn = "172.18.16.0/20"
protect_environment  = false
ecs_task_role_arn    = "arn:aws:iam::434960487817:role/ecsTaskExecutionRole"

default_tags = {
  ServiceOffering = "Cloud Foundation"
  Department      = "DevOps"
  Environment     = "dev"
  Owner           = "aws-titanio-dev@titan.io"
  Scope           = "Global"
  CostCenter      = null
  Compliance      = null
  Classification  = null
  Repository      = "https://github.com/Lumerin-protocol/collateral-margin.git//bedrock/02-dev"
  ManagedBy       = "Terraform"
}

foundation_tags = {
  Name          = null
  Capability    = null
  Application   = "Lumerin Collateral Margin - DEV"
  LifecycleDate = null
}
