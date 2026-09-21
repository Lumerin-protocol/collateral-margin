################################################################################
# SECRETS MANAGER
################################################################################
# ECS injects these at task start via valueFrom. The task definition stores
# the secret ARN, not the value. GitHub Actions only calls DescribeSecret
# (see 01_github_actions_iam.tf) so CI never receives the secret string.
#
# bedrock-foundation-role is the task execution role (local.titanio_role_arn).

resource "aws_iam_policy" "col_mar_secret_access" {
  count       = (var.keeper_service.create || var.futures_mm_service.create || var.perps_mm_service.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-secret-access-${substr(var.account_shortname, 8, 3)}"
  description = "Allow ECS tasks to read Collateral Margin secrets from Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = compact([
          var.keeper_service.create ? aws_secretsmanager_secret.keeper[0].arn : "",
          var.futures_mm_service.create ? aws_secretsmanager_secret.futures_mm[0].arn : "",
          var.perps_mm_service.create ? aws_secretsmanager_secret.perps_mm[0].arn : "",
        ])
      }
    ]
  })

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Collateral Margin Secret Access Policy",
      Capability = null,
    },
  )
}

resource "aws_iam_role_policy_attachment" "col_mar_secret_access" {
  count      = (var.keeper_service.create || var.futures_mm_service.create || var.perps_mm_service.create) ? 1 : 0
  provider   = aws.use1
  role       = "bedrock-foundation-role"
  policy_arn = aws_iam_policy.col_mar_secret_access[0].arn
}

################################################################################
# Keeper
################################################################################

resource "aws_secretsmanager_secret" "keeper" {
  count       = var.keeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-keeper-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Collateral-margin keeper secrets (liquidator key, Alchemy key, webhook secret)"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "${local.shortname}-keeper-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "keeper" {
  count     = var.keeper_service.create ? 1 : 0
  provider  = aws.use1
  secret_id = aws_secretsmanager_secret.keeper[0].id
  secret_string = jsonencode({
    liquidator_private_key = var.liquidator_private_key
    alchemy_api_key        = var.alchemy_api_key
    webhook_secret         = var.webhook_secret
  })
}

################################################################################
# Futures / portfolio market maker
################################################################################
# deploy-col-mar-mm.yml runs the portfolio app on this service and injects
# private_key as PRIVATE_KEY.

resource "aws_secretsmanager_secret" "futures_mm" {
  count       = var.futures_mm_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-futures-mm-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Portfolio market-maker secrets (signer key and Alchemy key)"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "${local.shortname}-futures-mm-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "futures_mm" {
  count     = var.futures_mm_service.create ? 1 : 0
  provider  = aws.use1
  secret_id = aws_secretsmanager_secret.futures_mm[0].id
  secret_string = jsonencode({
    private_key     = var.futures_mm_private_key
    alchemy_api_key = var.alchemy_api_key
  })
}

################################################################################
# Perps market maker
################################################################################
# CI does not roll this service. The secret is here so the task definition
# can inject PRIVATE_KEY the same way, and so the key is not left in GitHub.

resource "aws_secretsmanager_secret" "perps_mm" {
  count       = var.perps_mm_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-perps-mm-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Perps market-maker secrets (signer key and Alchemy key)"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "${local.shortname}-perps-mm-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "perps_mm" {
  count     = var.perps_mm_service.create ? 1 : 0
  provider  = aws.use1
  secret_id = aws_secretsmanager_secret.perps_mm[0].id
  secret_string = jsonencode({
    private_key     = var.perps_mm_private_key
    alchemy_api_key = var.alchemy_api_key
  })
}
