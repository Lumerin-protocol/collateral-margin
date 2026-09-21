variable "create_core" {
  description = "Decide whether or not to create the core resources (GitHub Actions IAM role)"
  type        = bool
  default     = false
}

################################################################################
# MARKET MAKER SERVICES (per venue) - SCAFFOLDING ONLY
################################################################################
# Two independent ECS services running the same Docker image but different
# entry points (MAKER_APP=perps vs MAKER_APP=futures). Terraform owns ONLY
# the scaffolding (security groups, ALB, target group, listener, Route53,
# log group, service shell, initial task-def stub).
#
# Personality (image, public env vars, desired count) is owned by
# deploy-col-mar-mm.yml. Private keys and the Alchemy key live in Secrets
# Manager (01_secrets_manager.tf) and are injected with ECS valueFrom.
# Both ECS service.task_definition and container_definitions are in
# lifecycle.ignore_changes; Terraform never updates them after first apply.
#
# Service map fields (all scaffolding):
#   create           bool   - toggle the entire service stack
#   task_worker_qty  number - desired_count INITIAL value; CI/CD owns it after first deploy
#   cnt_port         number - container port + target-group port + SG ingress rule
#   task_cpu         number - Fargate CPU units for the task
#   task_ram         number - Fargate memory (MB) for the task
################################################################################

variable "perps_mm_service" {
  description = "Perps Market Maker ECS service scaffolding"
  type = object({
    create          = bool
    task_worker_qty = number
    cnt_port        = number
    task_cpu        = number
    task_ram        = number
  })
  default = {
    create          = false
    task_worker_qty = 1
    cnt_port        = 3001
    task_cpu        = 256
    task_ram        = 512
  }
}

variable "futures_mm_service" {
  description = "Futures Market Maker ECS service scaffolding"
  type = object({
    create          = bool
    task_worker_qty = number
    cnt_port        = number
    task_cpu        = number
    task_ram        = number
  })
  default = {
    create          = false
    task_worker_qty = 1
    cnt_port        = 3001
    task_cpu        = 256
    task_ram        = 512
  }
}

################################################################################
# UNIFIED MARGIN KEEPER - SCAFFOLDING ONLY
################################################################################
# Single ECS service for coordinated perps + futures liquidation (replaces
# derivatives-marketplace svc-perps-keeper-*). Public runtime config is owned
# by deploy-keeper.yml from config/<env>.env. The liquidator key, Alchemy key,
# and webhook secret are injected from Secrets Manager.
################################################################################

variable "keeper_service" {
  description = "Unified collateral-margin keeper ECS service scaffolding"
  type = object({
    create          = bool
    task_worker_qty = number
    cnt_port        = number
    task_cpu        = number
    task_ram        = number
  })
  default = {
    create          = false
    task_worker_qty = 1
    cnt_port        = 3000
    task_cpu        = 256
    task_ram        = 512
  }
}

################################################################################
# Common Account Variables
################################################################################
variable "account_shortname" { description = "Code describing customer and lifecycle. E.g., titanio-dev, titanio-stg, titanio-lmn" }
variable "account_lifecycle" {
  description = "environment lifecycle: 'dev', 'stg', 'prd' (lmn uses 'prd')"
  type        = string
}
variable "account_number" {}
variable "default_region" {}
variable "region_shortname" {
  description = "Region 4 character shortname"
  default     = "use1"
}
variable "vpc_index" {}
variable "devops_keypair" {}
variable "titanio_net_edge_vpn" {}
variable "protect_environment" {}
variable "ecs_task_role_arn" {}
variable "default_tags" {
  description = "Default tag values common across all resources in this account."
  type        = map(string)
}
variable "foundation_tags" {
  description = "Default Tags for Bedrock Foundation resources"
  type        = map(string)
}
variable "provider_profile" {
  description = "AWS profile name used by the default provider"
}

################################################################################
# Secrets Manager (gitignored secret.auto.tfvars — never commit values)
################################################################################
# Same shape in 02-dev and 04-lmn:
#   alchemy_api_key         = "..."
#   liquidator_private_key  = "0x..."
#   futures_mm_private_key  = "0x..."
#   perps_mm_private_key    = "0x..."
#   webhook_secret          = ""   # optional; keeper WEBHOOK_SECRET

variable "alchemy_api_key" {
  description = "Alchemy API key injected into the keeper and both market makers"
  type        = string
  sensitive   = true
}

variable "liquidator_private_key" {
  description = "Keeper signer. Injected as LIQUIDATOR_PRIVATE_KEY"
  type        = string
  sensitive   = true
}

variable "futures_mm_private_key" {
  description = "Portfolio market-maker signer on the futures ECS service. Injected as PRIVATE_KEY"
  type        = string
  sensitive   = true
}

variable "perps_mm_private_key" {
  description = "Perps market-maker signer. Injected as PRIVATE_KEY on the perps ECS service. CI does not roll that service."
  type        = string
  sensitive   = true
}

variable "webhook_secret" {
  description = "Optional keeper WEBHOOK_SECRET. Empty string injects an empty value."
  type        = string
  sensitive   = true
  default     = ""
}
