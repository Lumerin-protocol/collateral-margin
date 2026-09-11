################################################################################
# GITHUB ACTIONS IAM ROLE AND POLICIES
################################################################################
# Bare-minimum IAM for deploy-col-mar-mm.yml and deploy-keeper.yml:
#   - register new ECS task definitions
#   - update ECS services to point at the new revisions
#   - PassRole the existing bedrock-foundation-role into ECS tasks
#
# All runtime config (env vars, secrets, contract addresses, RPC keys) is
# managed in GitHub Variables / Secrets and baked into each task-def
# revision by the workflow. There are no AWS Secrets Manager resources to
# read here.
#
# OIDC provider bootstrap (run once per account if not already present):
#   aws iam create-open-id-connect-provider \
#     --url https://token.actions.githubusercontent.com \
#     --client-id-list sts.amazonaws.com \
#     --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1b511abead59c6ce207077c0bf0e0043b1382612 \
#     --profile titanio-<env>
################################################################################

data "aws_iam_openid_connect_provider" "github" {
  provider = aws.use1
  url      = "https://token.actions.githubusercontent.com"
}

################################################################################
# IAM ROLE FOR GITHUB ACTIONS
################################################################################

resource "aws_iam_role" "github_actions_collateral_margin" {
  count    = var.create_core ? 1 : 0
  provider = aws.use1
  name     = "github-actions-${local.shortname}-v1-${substr(var.account_shortname, 8, 3)}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              for branch_filter in local.github_branch_filter :
              "repo:${local.github_org_repo}:${branch_filter}"
            ]
          }
        }
      }
    ]
  })

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "GitHub Actions - Collateral Margin"
    Capability = "CI/CD"
  })
}

################################################################################
# ECS UPDATE POLICY - Perps Market Maker service
################################################################################

resource "aws_iam_role_policy" "github_ecs_update_perps_mm" {
  count    = var.create_core && var.perps_mm_service.create ? 1 : 0
  provider = aws.use1
  name     = "ecs-update-${local.shortname}-perps-mm"
  role     = aws_iam_role.github_actions_collateral_margin[count.index].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdatePerpsMmECSService"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = [
          aws_ecs_service.perps_mm_use1[count.index].id
        ]
      },
      {
        Sid    = "TaskDefinitionOperations"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition"
        ]
        Resource = "*"
      },
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          var.ecs_task_role_arn,
          local.titanio_role_arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ReadECSCluster"
        Effect = "Allow"
        Action = [
          "ecs:ListServices",
          "ecs:DescribeClusters"
        ]
        Resource = "*"
      }
    ]
  })
}

################################################################################
# ECS UPDATE POLICY - Futures Market Maker service
################################################################################

resource "aws_iam_role_policy" "github_ecs_update_futures_mm" {
  count    = var.create_core && var.futures_mm_service.create ? 1 : 0
  provider = aws.use1
  name     = "ecs-update-${local.shortname}-futures-mm"
  role     = aws_iam_role.github_actions_collateral_margin[count.index].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdateFuturesMmECSService"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = [
          aws_ecs_service.futures_mm_use1[count.index].id
        ]
      },
      {
        Sid    = "TaskDefinitionOperations"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition"
        ]
        Resource = "*"
      },
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          var.ecs_task_role_arn,
          local.titanio_role_arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ReadECSCluster"
        Effect = "Allow"
        Action = [
          "ecs:ListServices",
          "ecs:DescribeClusters"
        ]
        Resource = "*"
      }
    ]
  })
}

################################################################################
# ECS UPDATE POLICY - Unified margin keeper service
################################################################################

resource "aws_iam_role_policy" "github_ecs_update_keeper" {
  count    = var.create_core && var.keeper_service.create ? 1 : 0
  provider = aws.use1
  name     = "ecs-update-${local.shortname}-keeper"
  role     = aws_iam_role.github_actions_collateral_margin[count.index].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdateKeeperECSService"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices"
        ]
        Resource = [
          aws_ecs_service.keeper_use1[count.index].id
        ]
      },
      {
        Sid    = "TaskDefinitionOperations"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition"
        ]
        Resource = "*"
      },
      {
        Sid    = "PassRoleToECS"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          var.ecs_task_role_arn,
          local.titanio_role_arn
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ReadECSCluster"
        Effect = "Allow"
        Action = [
          "ecs:ListServices",
          "ecs:DescribeClusters"
        ]
        Resource = "*"
      }
    ]
  })
}
