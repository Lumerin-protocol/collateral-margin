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

# Futures Market Maker. 512 CPU is 0.5 vCPU. Fargate's minimum memory at
# that size is 1024 MB. The 0.25 vCPU task stalled /health under a tick.
futures_mm_service = {
  create          = true
  task_worker_qty = 1
  cnt_port        = 3001
  task_cpu        = 512
  task_ram        = 1024
  ghcr_vers       = "auto" # newest col-mar-mm -dev tag, unless the running task is newer
}

# Unified liquidation keeper (replaces derivatives svc-perps-keeper-dev).
keeper_service = {
  create          = true
  task_worker_qty = 1
  cnt_port        = 3000
  task_cpu        = 256
  task_ram        = 512
}

# Insurance-fund debt. Addresses and the subgraph URL come from config/dev.env.
# Notifications stay off until the dashboard has been checked.
vault_monitoring = {
  create                   = true
  notifications_enabled    = false
  rate_minutes             = 5
  debt_util_warn_pct       = 50
  debt_util_crit_pct       = 80
  max_subgraph_age_minutes = 15
  oracle_metric_namespace  = "HashpriceOracle-DEV"
  dev_alerts_topic_name    = "titanio-dev-dev-alerts" # Slack; dev has no separate phone topic
  devops_alerts_topic_name = "titanio-dev-dev-alerts"
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
