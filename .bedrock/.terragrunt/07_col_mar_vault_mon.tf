################################################################################
# INSURANCE-FUND DEBT MONITOR
# Lambda reads the vault subgraph and one USDC balanceOf at that block.
# Keeper liveness (target health + sweep heartbeat) lives here too: a late
# keeper is what turns collectible debt into bad debt.
#
# The Lambda runs in the middle subnets so it can read the market maker's
# /health/raw through its internal ALB, which admits the VPC CIDR. Those
# subnets have NAT, which the subgraph and RPC calls go out through.
#
# The package is monitor/ zipped as-is: Node 24 runs the .ts sources without
# transpiling and node_modules holds only viem after the prod install that a
# terragrunt before_hook (root.hcl) runs on plan/apply. The AWS SDK comes
# from the runtime.
################################################################################

locals {
  vault_mon_env            = substr(var.account_shortname, 8, 3)
  vault_mon_ns             = "ColMarVault"
  vault_mon_name           = "${local.shortname}-vault-mon-${local.vault_mon_env}"
  vault_slack_topic_arn    = "arn:aws:sns:${var.default_region}:${var.account_number}:${var.vault_monitoring.dev_alerts_topic_name}"
  vault_page_topic_arn     = "arn:aws:sns:${var.default_region}:${var.account_number}:${var.vault_monitoring.devops_alerts_topic_name}"
  vault_critical_topic_arn = var.account_lifecycle == "prd" ? local.vault_page_topic_arn : local.vault_slack_topic_arn
  # Empty until notifications_enabled. Warning is Slack. Critical is Slack in
  # dev and the phone topic when account_lifecycle is prd.
  vault_warning_actions  = var.vault_monitoring.notifications_enabled ? [local.vault_slack_topic_arn] : []
  vault_critical_actions = var.vault_monitoring.notifications_enabled ? [local.vault_critical_topic_arn] : []
  vault_rpc_host         = var.account_lifecycle == "prd" ? "https://base-mainnet.g.alchemy.com/v2" : "https://base-sepolia.g.alchemy.com/v2"
  # The portfolio market maker is the futures_mm service.
  vault_mm_health     = var.vault_monitoring.create && var.futures_mm_service.create
  vault_mm_health_url = local.vault_mm_health ? "https://futuresmm.${local.hp_dns["exc"].name}/health/raw" : ""
}

################################################################################
# LAMBDA
################################################################################

data "archive_file" "vault_mon" {
  count       = var.vault_monitoring.create ? 1 : 0
  type        = "zip"
  source_dir  = var.vault_mon_dir
  excludes    = ["tests", "tsconfig.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]
  output_path = "${path.module}/07_col_mar_vault_mon.zip"
}

resource "aws_iam_role" "vault_mon" {
  count    = var.vault_monitoring.create ? 1 : 0
  provider = aws.use1
  name     = local.vault_mon_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor"
    Capability = "Monitoring"
  })
}

resource "aws_iam_role_policy_attachment" "vault_mon_logs" {
  count      = var.vault_monitoring.create ? 1 : 0
  provider   = aws.use1
  role       = aws_iam_role.vault_mon[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vault_mon_vpc" {
  count      = var.vault_monitoring.create ? 1 : 0
  provider   = aws.use1
  role       = aws_iam_role.vault_mon[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_security_group" "vault_mon" {
  count       = var.vault_monitoring.create ? 1 : 0
  provider    = aws.use1
  name        = local.vault_mon_name
  description = "Vault monitor Lambda: outbound only (subgraph, RPC, market-maker ALB)"
  vpc_id      = data.aws_vpc.use1_1.id

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor"
    Capability = "Monitoring"
  })
}

resource "aws_iam_role_policy" "vault_mon_metrics" {
  count    = var.vault_monitoring.create ? 1 : 0
  provider = aws.use1
  name     = "${local.vault_mon_name}-metrics"
  role     = aws_iam_role.vault_mon[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudwatch:PutMetricData"]
      Resource = "*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "vault_mon" {
  count             = var.vault_monitoring.create ? 1 : 0
  provider          = aws.use1
  name              = "/aws/lambda/${local.vault_mon_name}"
  retention_in_days = local.cloudwatch_event_retention

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor"
    Capability = "Monitoring"
  })
}

resource "aws_lambda_function" "vault_mon" {
  count         = var.vault_monitoring.create ? 1 : 0
  provider      = aws.use1
  function_name = local.vault_mon_name
  description   = "Publishes insurance-fund debt, halt, backing, protocol-backstop, order-book liquidity, and market-maker funds and health metrics"
  role          = aws_iam_role.vault_mon[0].arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  timeout       = 120
  memory_size   = 128

  filename         = data.archive_file.vault_mon[0].output_path
  source_code_hash = data.archive_file.vault_mon[0].output_base64sha256

  vpc_config {
    subnet_ids         = [for m in data.aws_subnet.middle_use1_1 : m.id]
    security_group_ids = [aws_security_group.vault_mon[0].id]
  }

  environment {
    variables = {
      VAULT_SUBGRAPH_URL  = var.vault_env.subgraph_url
      POINTS_SUBGRAPH_URL = var.vault_env.points_subgraph_url
      VAULT_ADDRESS       = var.vault_env.vault_address
      FUTURES_ADDRESS     = var.vault_env.futures_address
      PERPS_ADDRESS       = var.vault_env.perps_address
      MM_ADDRESS          = var.vault_env.mm_address
      MM_FUTURES_MARKETS  = tostring(var.vault_monitoring.mm_futures_markets)
      MM_HEALTH_URL       = local.vault_mm_health_url
      ETH_RPC_URL         = "${local.vault_rpc_host}/${var.alchemy_api_key}"
      CW_NAMESPACE        = local.vault_mon_ns
    }
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor"
    Capability = "Monitoring"
  })

  depends_on = [
    aws_iam_role_policy_attachment.vault_mon_logs,
    aws_iam_role_policy_attachment.vault_mon_vpc,
    aws_cloudwatch_log_group.vault_mon,
  ]
}

resource "aws_cloudwatch_event_rule" "vault_mon" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  name                = "${local.vault_mon_name}-schedule"
  description         = "Vault debt monitor every ${var.vault_monitoring.rate_minutes} minutes"
  schedule_expression = "rate(${var.vault_monitoring.rate_minutes} minutes)"

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor Schedule"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_event_target" "vault_mon" {
  count     = var.vault_monitoring.create ? 1 : 0
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.vault_mon[0].name
  target_id = "${local.vault_mon_name}-target"
  arn       = aws_lambda_function.vault_mon[0].arn
}

resource "aws_lambda_permission" "vault_mon" {
  count         = var.vault_monitoring.create ? 1 : 0
  provider      = aws.use1
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.vault_mon[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.vault_mon[0].arn
}

################################################################################
# KEEPER HEARTBEAT
# "sweep complete" is logged at info, including when the user list is empty.
# Error lines are pino level 50.
################################################################################

resource "aws_cloudwatch_log_metric_filter" "keeper_sweep" {
  count          = var.vault_monitoring.create && var.keeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-keeper-sweep-${local.vault_mon_env}"
  log_group_name = aws_cloudwatch_log_group.keeper_use1[0].name
  pattern        = "{ $.msg = \"sweep complete\" }"

  metric_transformation {
    name      = "KeeperSweepCount"
    namespace = local.vault_mon_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "keeper_error" {
  count          = var.vault_monitoring.create && var.keeper_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-keeper-error-${local.vault_mon_env}"
  log_group_name = aws_cloudwatch_log_group.keeper_use1[0].name
  pattern        = "{ $.level = 50 }"

  metric_transformation {
    name      = "KeeperErrorCount"
    namespace = local.vault_mon_ns
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# ALARMS
# Value alarms ignore missing data and keep their last state. CheckSuccess
# and the keeper heartbeat treat missing data as breaching.
################################################################################

resource "aws_cloudwatch_metric_alarm" "vault_uncovered_loss" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-uncovered-loss-${local.vault_mon_env}"
  alarm_description   = "Uncovered loss is above 0. A trader's loss exceeded their collateral and protocol capital does not cover it. Top up exactly that amount with depositInsuranceFund. The alarm clears once it is covered. Do not raise the cap to hide it."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "UncoveredLoss"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Uncovered Loss"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_backstop_equity" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backstop-equity-${local.vault_mon_env}"
  alarm_description   = "Protocol backstop equity (balance + unrealized PnL + pending funding at the mark) is negative. Liquidated positions parked on the backstop are losing and the loss is not yet booked as BadDebt; it lands in uncovered loss when the legs unwind, offset, or settle. Check the backstop legs on the dashboard, make sure unwinds are flowing (keeper BACKSTOP_UNWIND_ENABLED or a manual unwindBackstop), and be ready to depositInsuranceFund the shortfall. Warning only."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackstopEquity"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = 0
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backstop Equity"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_util_warn" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-util-warn-${local.vault_mon_env}"
  alarm_description   = "Insurance debt is at or above ${var.vault_monitoring.debt_util_warn_pct}% of the cap. Confirm uncovered loss is 0 and that the keeper and oracle are healthy. If it is only timing debt, raise the cap with set-insurance-debt-cap.ts."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "InsuranceDebtUtilizationPct"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.debt_util_warn_pct
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Utilization Warning"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_util_crit" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-util-crit-${local.vault_mon_env}"
  alarm_description   = "Insurance debt is at or above ${var.vault_monitoring.debt_util_crit_pct}% of the cap. The vault halts when a borrow crosses 100% and stays halted until resume(). Raise the cap or top up now, after checking uncovered loss, the keeper, and the oracle."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "InsuranceDebtUtilizationPct"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.debt_util_crit_pct
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Utilization Critical"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_halted" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-halted-${local.vault_mon_env}"
  alarm_description   = "Vault is halted. New orders and withdrawals are stopped. Liquidations, settlement, funding, cancels, deposits, and owner recovery still run. Only the Safe can resume. See docs/insurance-debt.md: identify the trip, top up uncovered loss, confirm the rest is timing debt, then raise the cap or top up and call resume()."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Halted"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Halted"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_backing_gap" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backing-gap-${local.vault_mon_env}"
  alarm_description   = "Backing gap is above 0. The vault holds less USDC than total supply minus insurance debt. Halt if it is not already halted, and compare subgraph numbers with the contract views. Revoke both venues before changing balances."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackingGap"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backing Gap"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_margin_engine_unset" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-margin-engine-unset-${local.vault_mon_env}"
  alarm_description   = "Margin engine is unset. The effective debt cap is 0, and the vault halts if any debt is outstanding. Restore the margin engine, then resume."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "MarginEngineUnset"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Margin Engine Unset"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_check_success" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-check-success-${local.vault_mon_env}"
  alarm_description   = "Vault monitor has not published a successful check for 15 minutes. The subgraph or RPC is not answering, or the Lambda is not running. Debt value alarms are blind until this recovers."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "CheckSuccess"
  namespace           = local.vault_mon_ns
  period              = 900
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Check Success"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_subgraph_age" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-subgraph-age-${local.vault_mon_env}"
  alarm_description   = "Vault subgraph is more than ${var.vault_monitoring.max_subgraph_age_minutes} minutes behind. Debt alarms are blind. Nothing on-chain is affected. Read the contract views directly until the indexer recovers, then redeploy or resync it."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphDataAgeSeconds"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.max_subgraph_age_minutes * 60
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Subgraph Age"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_subgraph_behind" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-subgraph-behind-${local.vault_mon_env}"
  alarm_description   = "Vault subgraph is more than ${var.vault_monitoring.max_subgraph_age_minutes} minutes of blocks behind the chain head. The tag is still indexing or stalled. Debt readings from the index are not current."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphBlocksBehind"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.max_subgraph_age_minutes * 30
  treat_missing_data  = "ignore"
  dimensions          = { Subgraph = "vault" }
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Subgraph Behind"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "points_subgraph_behind" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-points-subgraph-behind-${local.vault_mon_env}"
  alarm_description   = "Points subgraph is more than ${var.vault_monitoring.max_subgraph_age_minutes} minutes of blocks behind the chain head. The tag is still indexing or stalled."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphBlocksBehind"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.max_subgraph_age_minutes * 30
  treat_missing_data  = "ignore"
  dimensions          = { Subgraph = "points" }
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Points Subgraph Behind"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_subgraph_errors" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-subgraph-errors-${local.vault_mon_env}"
  alarm_description   = "Vault subgraph reports indexing errors. Debt alarms are blind. Read the contract views directly, then redeploy or resync the indexer."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphIndexingErrors"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Subgraph Errors"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "keeper_unhealthy" {
  count               = var.vault_monitoring.create && var.keeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-keeper-unhealthy-${local.vault_mon_env}"
  alarm_description   = "Keeper target has no healthy host. Underwater accounts are not being liquidated, so losses can grow past collateral. Restart the keeper, let it liquidate, then top up the uncovered loss it records."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  dimensions = {
    LoadBalancer = aws_alb.keeper_int_use1[0].arn_suffix
    TargetGroup  = aws_alb_target_group.keeper_int_use1[0].arn_suffix
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Keeper Unhealthy"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "keeper_silent" {
  count               = var.vault_monitoring.create && var.keeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-keeper-silent-${local.vault_mon_env}"
  alarm_description   = "No keeper \"sweep complete\" log for 5 minutes. The process may be up and still not liquidating. Restart it, let overdue liquidations run, then top up uncovered loss."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "KeeperSweepCount"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Keeper Silent"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "keeper_errors" {
  count               = var.vault_monitoring.create && var.keeper_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-keeper-errors-${local.vault_mon_env}"
  alarm_description   = "Keeper logged an error (pino level 50). Sweeps that throw skip liquidation for that cycle. Read /ecs/col-mar-keeper logs, restart if the loop is stuck, then top up any uncovered loss."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "KeeperErrorCount"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Keeper Errors"
    Capability = "Monitoring"
  })
}

################################################################################
# ORDER BOOK AND MARKET MAKER
# Read on-chain, so they fire whether the market maker is quoting one side,
# halted, or not running at all. Missing data means the market check failed,
# which MarketCheckSuccess reports on its own.
################################################################################

resource "aws_cloudwatch_metric_alarm" "book_one_sided" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-book-one-sided-${local.vault_mon_env}"
  alarm_description   = "A perps or quoted futures book has had no bids or no asks for 15 minutes, so traders can only trade one way. Find the empty side on the vault dashboard (Book levels by market). Usual causes: the market maker hit its maxPositionNotionalUsd cap (check MM position), its utilization gate (check MM utilization), it halted, or it is not running."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "BookMinSideLevels"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Book One-Sided"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_perps_position" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-perps-position-${local.vault_mon_env}"
  alarm_description   = "Market-maker perps position notional is above ${var.vault_monitoring.mm_perps_position_warn_usd} USD, close to its maxPositionNotionalUsd cap. At the cap it stops quoting the side that adds to the position and the book goes one-sided. Raise the cap in market-maker/configs/portfolio.<env>.yml if collateral allows, or take the other side to flatten it. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MmPerpsPositionNotional"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.mm_perps_position_warn_usd
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Perps Position"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_futures_position" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-futures-position-${local.vault_mon_env}"
  alarm_description   = "Market-maker position notional in one futures expiry is above ${var.vault_monitoring.mm_futures_position_warn_usd} USD, close to its per-expiry maxPositionNotionalUsd cap. At the cap that expiry's book goes one-sided. Raise the cap in market-maker/configs/portfolio.<env>.yml if collateral allows. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MmFuturesMaxPositionNotional"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.mm_futures_position_warn_usd
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Futures Position"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_utilization" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-utilization-${local.vault_mon_env}"
  alarm_description   = "Market-maker margin utilization (portfolio IM / vault balance) is above ${var.vault_monitoring.mm_util_warn_pct}%. Past its maxUtilizationPct it only quotes risk-reducing sides, and on a flat position it quotes nothing. Send USDC to the market-maker wallet (auto-deposit moves it into the vault) or lower its caps. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MmUtilizationPct"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.mm_util_warn_pct
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Utilization"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_eth_low" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-eth-low-${local.vault_mon_env}"
  alarm_description   = "Market-maker wallet has less than ${var.vault_monitoring.mm_min_eth} ETH for gas. When it runs out it stops quoting and every book empties. Send ETH to the MM_ADDRESS in config/<env>.env. Warning only."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MmEthBalance"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = var.vault_monitoring.mm_min_eth
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM ETH Low"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "market_check_success" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-market-check-success-${local.vault_mon_env}"
  alarm_description   = "The monitor has not read the order books and market-maker wallet for 15 minutes, so book and market-maker alarms are blind. The vault checks are unaffected. Read the vault monitor Lambda log for \"market maker check failed\"."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MarketCheckSuccess"
  namespace           = local.vault_mon_ns
  period              = 900
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Market Check Success"
    Capability = "Monitoring"
  })
}

################################################################################
# MARKET-MAKER STATE
# Mark drift is on-chain. The rest is the market maker's /health/raw: states
# that keep its old orders resting, so the book looks fine while going stale.
################################################################################

resource "aws_cloudwatch_metric_alarm" "book_mark_drift" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-book-mark-drift-${local.vault_mon_env}"
  alarm_description   = "A two-sided book's mid has been more than ${var.vault_monitoring.book_drift_warn_bps} bps from the mark for 15 minutes. The market maker is leaving stale quotes that takers can trade against. Check the market-maker state panel for a quarantined market, gas throttle, or paused placements, then the market-maker log. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "BookMaxMidDriftBps"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = var.vault_monitoring.book_drift_warn_bps
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Book Mark Drift"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_not_running" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-not-running-${local.vault_mon_env}"
  alarm_description   = "The market maker's /health status has not been running for 10 minutes: it halted (daily loss or collateral, see lastError), was stopped with POST /stop, or is still initializing. A halt cancels every order. Read lastError on /health and the market-maker log. Warning only."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MmRunning"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Not Running"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_quarantined" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-quarantined-${local.vault_mon_env}"
  alarm_description   = "A market has been quarantined by the market maker's circuit breaker for 15 minutes. It no longer requotes that market, but its old orders stay on the book. Find the market and its lastError on /health, then the \"market update failed\" lines in the market-maker log. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MmQuarantinedMarkets"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = 0
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Quarantined Market"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_throttled" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-throttled-${local.vault_mon_env}"
  alarm_description   = "The market maker has been gas-throttled for 10 minutes. The hourly budget slows requoting; the daily budget stops it, leaving stale quotes. Check throttleReason on /health and raise maxGasBudgetPerHourUsd or maxGasBudgetPerDayUsd if the spend is expected. Warning only."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "MmThrottled"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Gas Throttled"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_paused_new" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-paused-new-${local.vault_mon_env}"
  alarm_description   = "The market maker has failed to refresh gas or collateral for 10 minutes, so it places no new orders and its existing ones go stale. Usually the RPC: read \"shared input update failed\" in the market-maker log. Warning only."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "MmPausedNew"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Paused Placements"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_no_own_orders" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-no-own-orders-${local.vault_mon_env}"
  alarm_description   = "The market maker has had no resting orders in at least one market for 15 minutes. That book may still look two-sided because of other traders' orders. Find the market on the own-orders panel and check its breaker and lastError on /health. Warning only."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MmMinOwnOrders"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM No Own Orders"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "mm_health_check" {
  count               = local.vault_mm_health ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-mm-health-check-${local.vault_mon_env}"
  alarm_description   = "The monitor has not read the market maker's /health for 15 minutes, so the market-maker state alarms are blind. Either the service is down (see the no-tick alarm and the ALB target health) or the Lambda cannot reach the internal ALB. Read the vault monitor Lambda log for \"market maker health failed\"."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MmHealthCheckSuccess"
  namespace           = local.vault_mon_ns
  period              = 900
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Health Check"
    Capability = "Monitoring"
  })
}

################################################################################
# DASHBOARD
################################################################################

resource "aws_cloudwatch_dashboard" "vault" {
  count          = var.vault_monitoring.create ? 1 : 0
  provider       = aws.use1
  dashboard_name = "${local.shortname}-vault-${local.vault_mon_env}"

  dashboard_body = jsonencode({
    widgets = concat(
      [
        {
          type   = "alarm"
          x      = 0
          y      = 0
          width  = 24
          height = 4
          properties = {
            title = "Alarm Status"
            alarms = concat(
              aws_cloudwatch_metric_alarm.vault_uncovered_loss[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_equity[*].arn,
              aws_cloudwatch_metric_alarm.vault_util_warn[*].arn,
              aws_cloudwatch_metric_alarm.vault_util_crit[*].arn,
              aws_cloudwatch_metric_alarm.vault_halted[*].arn,
              aws_cloudwatch_metric_alarm.vault_backing_gap[*].arn,
              aws_cloudwatch_metric_alarm.vault_margin_engine_unset[*].arn,
              aws_cloudwatch_metric_alarm.vault_check_success[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_age[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_behind[*].arn,
              aws_cloudwatch_metric_alarm.points_subgraph_behind[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_errors[*].arn,
              aws_cloudwatch_metric_alarm.keeper_unhealthy[*].arn,
              aws_cloudwatch_metric_alarm.keeper_silent[*].arn,
              aws_cloudwatch_metric_alarm.keeper_errors[*].arn,
              aws_cloudwatch_metric_alarm.book_one_sided[*].arn,
              aws_cloudwatch_metric_alarm.mm_perps_position[*].arn,
              aws_cloudwatch_metric_alarm.mm_futures_position[*].arn,
              aws_cloudwatch_metric_alarm.mm_utilization[*].arn,
              aws_cloudwatch_metric_alarm.mm_eth_low[*].arn,
              aws_cloudwatch_metric_alarm.market_check_success[*].arn,
              aws_cloudwatch_metric_alarm.book_mark_drift[*].arn,
              aws_cloudwatch_metric_alarm.mm_not_running[*].arn,
              aws_cloudwatch_metric_alarm.mm_quarantined[*].arn,
              aws_cloudwatch_metric_alarm.mm_throttled[*].arn,
              aws_cloudwatch_metric_alarm.mm_paused_new[*].arn,
              aws_cloudwatch_metric_alarm.mm_no_own_orders[*].arn,
              aws_cloudwatch_metric_alarm.mm_health_check[*].arn,
            )
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 4
          width  = 12
          height = 6
          properties = {
            title  = "Debt (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "InsuranceDebt", { label = "Debt" }],
              [local.vault_mon_ns, "TimingDebt", { label = "Timing debt" }],
              [local.vault_mon_ns, "UncoveredLoss", { label = "Uncovered loss", color = "#d62728" }],
              [local.vault_mon_ns, "InsuranceDebtCap", { label = "Cap" }],
              [local.vault_mon_ns, "InsuranceCapital", { label = "Capital" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 4
          width  = 6
          height = 6
          properties = {
            title  = "Utilization %"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "InsuranceDebtUtilizationPct", { label = "Debt / cap" }],
            ]
            annotations = {
              horizontal = [
                { label = "warn", value = var.vault_monitoring.debt_util_warn_pct },
                { label = "critical", value = var.vault_monitoring.debt_util_crit_pct },
              ]
            }
          }
        },
        {
          type   = "metric"
          x      = 18
          y      = 4
          width  = 6
          height = 6
          properties = {
            title  = "Halted"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "Halted", { label = "Halted", stat = "Maximum" }],
              [local.vault_mon_ns, "MarginEngineUnset", { label = "Engine unset", stat = "Maximum" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 10
          width  = 12
          height = 6
          properties = {
            title  = "Balances available for a top-up (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "InsuranceFundBalance", { label = "Insurance fund" }],
              [local.vault_mon_ns, "FuturesFeeBalance", { label = "Futures fees" }],
              [local.vault_mon_ns, "PerpsFeeBalance", { label = "Perps fees" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 10
          width  = 6
          height = 6
          properties = {
            title  = "Backing gap (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackingGap", { label = "Supply - debt - USDC", color = "#d62728" }],
              [local.vault_mon_ns, "TraderBadDebtTotal", { label = "Trader bad debt" }],
              [local.vault_mon_ns, "BackstopBadDebtTotal", { label = "of which backstop" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 22
          width  = 12
          height = 6
          properties = {
            title  = "Protocol backstop (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackstopEquity", { label = "Equity at mark", color = "#d62728" }],
              [local.vault_mon_ns, "BackstopBalance", { label = "Ledger balance" }],
              [local.vault_mon_ns, "BackstopUnrealizedPnl", { label = "Unrealized PnL" }],
              [local.vault_mon_ns, "BackstopPendingFunding", { label = "Pending funding" }],
            ]
            annotations = { horizontal = [{ label = "loss forming", value = 0 }] }
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 22
          width  = 12
          height = 6
          properties = {
            title  = "Protocol backstop exposure (raw units)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackstopFuturesNetQuantity", { label = "Futures net contracts" }],
              [local.vault_mon_ns, "BackstopPerpsNetQuantity", { label = "Perps net (1e6)" }],
              [local.vault_mon_ns, "BackstopOpenLegs", { label = "Open legs", stat = "Maximum" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 18
          y      = 10
          width  = 6
          height = 6
          properties = {
            title  = "Monitor health"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "CheckSuccess", { label = "Check success", stat = "Minimum" }],
              [local.vault_mon_ns, "SubgraphIndexingErrors", { label = "Indexing errors", stat = "Maximum" }],
              [local.vault_mon_ns, "SubgraphDataAgeSeconds", { label = "Subgraph age (s)", stat = "Maximum" }],
              [local.vault_mon_ns, "MarketCheckSuccess", { label = "Market check success", stat = "Minimum" }],
              [local.vault_mon_ns, "MmHealthCheckSuccess", { label = "MM health success", stat = "Minimum" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 28
          width  = 12
          height = 6
          properties = {
            title  = "Book levels by market (bids / asks)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookBidLevels\"', 'Minimum', 300)", id = "bids", label = "bids" }],
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookAskLevels\"', 'Minimum', 300)", id = "asks", label = "asks" }],
              [local.vault_mon_ns, "BookMinSideLevels", { label = "Emptiest side", stat = "Minimum", color = "#d62728" }],
            ]
            annotations = { horizontal = [{ label = "one-sided", value = 1 }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 28
          width  = 12
          height = 6
          properties = {
            title  = "Market-maker position notional (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"MmPositionNotional\"', 'Maximum', 300)", id = "pos", label = "" }],
            ]
            annotations = {
              horizontal = [
                { label = "perps warn", value = var.vault_monitoring.mm_perps_position_warn_usd },
                { label = "futures warn", value = var.vault_monitoring.mm_futures_position_warn_usd },
              ]
            }
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 34
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker collateral (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "MmVaultBalance", { label = "Vault balance" }],
              [local.vault_mon_ns, "MmPortfolioIM", { label = "Portfolio IM" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 34
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker utilization %"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "MmUtilizationPct", { label = "IM / vault balance", stat = "Maximum" }],
            ]
            annotations = { horizontal = [{ label = "warn", value = var.vault_monitoring.mm_util_warn_pct }] }
            yAxis       = { left = { min = 0, max = 100 } }
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 34
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker ETH for gas"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "MmEthBalance", { label = "ETH", stat = "Minimum" }],
            ]
            annotations = { horizontal = [{ label = "low", value = var.vault_monitoring.mm_min_eth }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 40
          width  = 12
          height = 6
          properties = {
            title  = "Top-of-book spread (bps)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookSpreadBps\"', 'Maximum', 300)", id = "spread", label = "" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 40
          width  = 12
          height = 6
          properties = {
            title  = "Book mid drift from mark (bps)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookMidDriftBps\"', 'Maximum', 300)", id = "drift", label = "" }],
            ]
            annotations = { horizontal = [{ label = "stale", value = var.vault_monitoring.book_drift_warn_bps }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 16
          width  = 8
          height = 6
          properties = {
            title  = "Oracle data age (minutes)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [var.vault_monitoring.oracle_metric_namespace, "oracle_data_age_minutes", "Environment", local.vault_mon_env, { label = "Hashprice age" }],
            ]
          }
        },
      ],
      var.keeper_service.create ? [
        {
          type   = "metric"
          x      = 8
          y      = 16
          width  = 16
          height = 6
          properties = {
            title  = "Keeper"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", one(aws_alb.keeper_int_use1[*].arn_suffix), "TargetGroup", one(aws_alb_target_group.keeper_int_use1[*].arn_suffix), { label = "Healthy hosts", stat = "Minimum" }],
              [local.vault_mon_ns, "KeeperSweepCount", { label = "Sweeps", stat = "Sum" }],
              [local.vault_mon_ns, "KeeperErrorCount", { label = "Errors", stat = "Sum" }],
            ]
          }
        },
      ] : [],
      [for widget in [
        {
          type   = "metric"
          x      = 0
          y      = 46
          width  = 12
          height = 6
          properties = {
            title  = "Market-maker state (/health)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "MmRunning", { label = "Running", stat = "Minimum" }],
              [local.vault_mon_ns, "MmQuarantinedMarkets", { label = "Quarantined markets", stat = "Maximum" }],
              [local.vault_mon_ns, "MmThrottled", { label = "Gas throttled", stat = "Maximum" }],
              [local.vault_mon_ns, "MmPausedNew", { label = "Placements paused", stat = "Maximum" }],
              [local.vault_mon_ns, "MmMarketCount", { label = "Markets", stat = "Minimum" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 46
          width  = 12
          height = 6
          properties = {
            title  = "Market-maker own orders by market"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"MmOwnOrders\"', 'Minimum', 300)", id = "orders", label = "" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
      ] : widget if local.vault_mm_health],
    )
  })
}
