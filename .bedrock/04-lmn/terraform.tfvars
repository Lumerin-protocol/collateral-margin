########################################
# Service Toggles - SCAFFOLDING ONLY
########################################
# Runtime config (image, env vars, secrets, addresses) is owned by the
# deploy-col-mar-mm.yml workflow via GitHub Variables / GitHub Secrets.
########################################

create_core = true

# Perps Market Maker - DNS NOTE: perpsmm.hashpower.exchange currently
# belongs to derivatives-marketplace. Leave create=false until cutover.
perps_mm_service = {
  create          = true
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
