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

# Insurance-fund debt. Addresses and the subgraph URL come from config/prd.env.
# Notifications stay off until the dashboard has been checked.
vault_monitoring = {
  create                   = true
  notifications_enabled    = false
  rate_minutes             = 5
  debt_util_warn_pct       = 50
  debt_util_crit_pct       = 80
  max_subgraph_age_minutes = 15
  oracle_metric_namespace  = "HashpriceOracle-LMN"
  dev_alerts_topic_name    = "titanio-lmn-dev-alerts"    # Slack
  devops_alerts_topic_name = "titanio-lmn-devops-alerts" # Phone
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
