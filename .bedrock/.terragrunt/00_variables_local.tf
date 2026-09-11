################################
# LOCAL VARIABLES 
################################
locals {
  # Short product code used in resource names. Bounded by AWS limits
  # (ALB <= 32 chars, Target Group <= 32 chars). Combined with venue
  # suffix (-perps-mm / -futures-mm) and env (-dev|stg|lmn), names like
  # alb-col-mar-futures-mm-dev land at 26 chars.
  shortname                  = "col-mar"
  log_group_name             = "bedrock-${local.shortname}-${substr(var.account_shortname, 8, 3)}"
  cloudwatch_event_retention = 90

  titanio_net_ecr  = "343351459450.dkr.ecr.us-east-1.amazonaws.com"
  titanio_role_arn = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"

  # Cluster lookup target. The derivatives-marketplace repo provisions
  # this cluster (resource aws_ecs_cluster.derivatives_marketplace).
  # If that resource ever moves or renames, update this single line.
  derivatives_ecs_cluster_name = "ecs-derivatives-marketplace-${substr(var.account_shortname, 8, 3)}"

  # MAKER_ENV value injected into containers; the docker entrypoint
  # uses it to select configs/{perps,futures}.${MAKER_ENV}.yml. Production
  # accounts (lmn) use the "prd" YAML; dev/stg map 1:1.
  maker_env = var.account_lifecycle == "prd" ? "prd" : var.account_lifecycle

  ################################
  # GITHUB ACTIONS CI/CD
  ################################
  # NOTE: Case-sensitive! Must match GitHub exactly.
  github_org_repo = "Lumerin-protocol/collateral-margin"

  # DEV uses a list to allow both dev and cicd/* branches; STG/PRD use single-item lists.
  github_branch_filter = var.account_lifecycle == "dev" ? [
    "ref:refs/heads/dev",
    "ref:refs/heads/cicd/*",
    "environment:dev"
    ] : (
    var.account_lifecycle == "stg" ? ["ref:refs/heads/stg", "environment:stg"] : ["ref:refs/heads/main", "environment:main"]
  )

  ################################
  # DOMAIN CONSTRUCTION (from Route53 data lookups)
  ################################
  # Public zone for this env: hashpower.exchange (lmn) or {dev,stg}.hashpower.exchange.
  domain_zone_name = local.hp_dns["exc"].name
}
