########################################
# Service Toggles - SCAFFOLDING ONLY
########################################
# Public runtime config is config/prd.env. Private keys and the Alchemy key
# are Secrets Manager, seeded from gitignored secret.auto.tfvars:
#   alchemy_api_key, liquidator_private_key, futures_mm_private_key,
#   perps_mm_private_key, and optional webhook_secret.
########################################

create_core = true

# Unused. Quoting runs on the futures MM service. Leave false so LMN does not
# build the empty perps service, its ALB, or perpsmm.hashpower.exchange.
perps_mm_service = {
  create          = false
  task_worker_qty = 1
  cnt_port        = 3001
  task_cpu        = 256
  task_ram        = 512
}

# Futures Market Maker
futures_mm_service = {
  create          = true
  task_worker_qty = 1
  cnt_port        = 3001
  task_cpu        = 256
  task_ram        = 512
}

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
  subgraph_url             = "https://api.goldsky.com/api/public/project_cmmz5dm4l7ocp01xng61y5nwr/subgraphs/collateral-vault/lmn-latest/gn"
  vault_address            = "0x0730422E49B76A2D36d51304ACEcbe4f444821F8"
  futures_address          = "0xf97a1bbfb5e061ef73dad8ebf25939d93639fb7f"
  perps_address            = "0x794f9e63b7666985256f1d2763ee24cc0b528199"
  rate_minutes             = 5
  debt_util_warn_pct       = 50
  debt_util_crit_pct       = 80
  max_subgraph_age_minutes = 15
  oracle_metric_namespace  = "HashpriceOracle-LMN"
}

########################################
# Account metadata
########################################
provider_profile  = "titanio-lmn"
account_shortname = "titanio-lmn"
account_number    = "330280307271"
account_lifecycle = "prd"
default_region    = "us-east-1"
region_shortname  = "use1"

########################################
# Environment Specific Variables
########################################
vpc_index            = 1
devops_keypair       = "bedrock-titanio-lmn-use1"
titanio_net_edge_vpn = "172.18.16.0/20"
protect_environment  = false
ecs_task_role_arn    = "arn:aws:iam::330280307271:role/ecsTaskExecutionRole"

default_tags = {
  ServiceOffering = "Cloud Foundation"
  Department      = "DevOps"
  Environment     = "lmn"
  Owner           = "aws-titanio-lmn@titan.io"
  Scope           = "Global"
  CostCenter      = null
  Compliance      = null
  Classification  = null
  Repository      = "https://github.com/Lumerin-protocol/collateral-margin.git//bedrock/04-lmn"
  ManagedBy       = "Terraform"
}

foundation_tags = {
  Name          = null
  Capability    = null
  Application   = "Lumerin Collateral Margin - LMN"
  LifecycleDate = null
}
