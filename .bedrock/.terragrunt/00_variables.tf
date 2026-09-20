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
# Personality (image, env vars, secrets) is owned by the deploy-col-mar-mm.yml
# workflow, which builds the image, pushes to GHCR, and registers a new
# task-def revision per deploy. Both ECS service.task_definition and ECS
# task_definition.container_definitions are in lifecycle.ignore_changes;
# Terraform never updates them after first apply.
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
# derivatives-marketplace svc-perps-keeper-*). Runtime config is owned by
# deploy-keeper.yml via GitHub Variables / Secrets.
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
