########################################
# Service Toggles - SCAFFOLDING ONLY
########################################
# Runtime config (image, env vars, secrets, addresses) is owned by the
# deploy-col-mar-mm.yml workflow via GitHub Variables / GitHub Secrets.
# The maps below configure ONLY the immutable infrastructure shell.
########################################

create_core = true

# Perps Market Maker - active. Legacy derivatives perps MM was decommissioned
# in 2026-Q2; perpsmm.dev.hashpower.exchange now points at this stack's ALB.
perps_mm_service = {
  create          = true
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
