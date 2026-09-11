################################################################################
# APP-SPECIFIC GLOBAL LOOKUPS (data files, dns, iam, etc...)
################################################################################

################################################################################
# DEVOPS/BEDROCK SOURCE INFO
################################################################################

################################
# WAF Protection - for Cloudfront (Global Scope)
################################
data "aws_wafv2_web_acl" "bedrock_waf_cloudfront" {
  provider = aws.use1
  name     = "waf-bedrock-cloudfront"
  scope    = "CLOUDFRONT"
}
################################################################################
# ECS CLUSTER LOOKUP
################################################################################
# The ECS cluster is owned by the derivatives-marketplace repo (resource
# aws_ecs_cluster.derivatives_marketplace). We share the cluster across
# both repos to avoid running two Fargate clusters per account.
#
# Coupling note: if derivatives-marketplace destroys the cluster, the
# services defined in this repo will stop. Coordinate cluster-level
# changes between the two repos.
################################################################################

data "aws_ecs_cluster" "derivatives" {
  provider     = aws.use1
  cluster_name = local.derivatives_ecs_cluster_name
}


################################
# Hashpower DNS & ACM Lookups
#
# Conditional: lmn resolves root domains, dev/stg resolve env subdomains.
# Dependent code uses the same local reference regardless of account.
#
# Usage:
#   DNS zone:
#     local.hp_dns["exc"].zone_id
#     local.hp_dns["exc"].name   # "hashpower.exchange" (lmn) or "dev.hashpower.exchange" (dev)
#     local.hp_dns["tok"].zone_id
#
#   ACM cert:
#     local.hp_acm["exc"].arn
#     local.hp_acm["tok"].arn
#
#   Keys: exc = hashpower.exchange, tok = hpow.io, com = hashpower.io (when acquired)
################################
locals {
  env_prefix = substr(var.account_shortname, 8, 3)
  is_lmn     = local.env_prefix == "lmn"

  hashpower_domains = {
    exc = "hashpower.exchange"
    tok = "hpow.io"
    # com = "hashpower.io"  # uncomment when domain is acquired
  }
}

# DNS: root zones in titanio-net (lmn only)
data "aws_route53_zone" "hp_root" {
  for_each     = local.is_lmn ? local.hashpower_domains : {}
  provider     = aws.titanio-net
  name         = each.value
  private_zone = false
}

# DNS: env subdomain zones in local account (dev, stg)
data "aws_route53_zone" "hp_env" {
  for_each     = local.is_lmn ? {} : local.hashpower_domains
  provider     = aws.use1
  name         = "${local.env_prefix}.${each.value}"
  private_zone = false
}

# ACM: always in local account, domain conditional on env
data "aws_acm_certificate" "hp" {
  for_each = local.hashpower_domains
  provider = aws.use1
  domain   = local.is_lmn ? each.value : "${local.env_prefix}.${each.value}"
  statuses = ["ISSUED"]
}

locals {
  hp_dns = local.is_lmn ? data.aws_route53_zone.hp_root : data.aws_route53_zone.hp_env
  hp_acm = data.aws_acm_certificate.hp
}

output "hp_dns" {
  value = { for k, v in local.hp_dns : k => { zone_id = v.zone_id, name = v.name } }
}

output "hp_acm" {
  value = { for k, v in local.hp_acm : k => {
    arn    = v.arn
    domain = local.is_lmn ? local.hashpower_domains[k] : "${local.env_prefix}.${local.hashpower_domains[k]}"
  } }
}

