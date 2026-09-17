################################################################################
# OUTPUTS - # Usage: terragrunt output <name>
################################################################################

output "github_actions_role_arn" {
  description = "ARN of the IAM role for GitHub Actions"
  value       = var.create_core ? aws_iam_role.github_actions_collateral_margin[0].arn : null
}

output "github_actions_role_name" {
  description = "Name of the IAM role for GitHub Actions"
  value       = var.create_core ? aws_iam_role.github_actions_collateral_margin[0].name : null
}

################################################################################
# SERVICE ENDPOINTS (internal ALB, reachable via VPN)
################################################################################

output "perps_mm_endpoint" {
  description = "Perps Market Maker health endpoint (internal ALB via VPN)"
  value       = var.perps_mm_service.create ? "https://perpsmm.${local.hp_dns["exc"].name}/health" : null
}

output "futures_mm_endpoint" {
  description = "Futures Market Maker health endpoint (internal ALB via VPN)"
  value       = var.futures_mm_service.create ? "https://futuresmm.${local.hp_dns["exc"].name}/health" : null
}

output "col_mar_keeper_endpoint" {
  description = "Unified margin keeper health endpoint (internal ALB via VPN)"
  value       = var.keeper_service.create ? "https://keeper.${local.hp_dns["exc"].name}/health" : null
}
