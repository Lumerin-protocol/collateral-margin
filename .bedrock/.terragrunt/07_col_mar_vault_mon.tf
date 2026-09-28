################################################################################
# INSURANCE-FUND DEBT MONITOR
# Lambda reads the vault subgraph and one USDC balanceOf at that block.
# Keeper liveness (target health + sweep heartbeat) lives here too: a late
# keeper is what turns collectible debt into bad debt.
################################################################################

locals {
  vault_mon_env       = substr(var.account_shortname, 8, 3)
  vault_mon_ns        = "ColMarVault"
  vault_mon_name      = "${local.shortname}-vault-mon-${local.vault_mon_env}"
  vault_alert_actions = var.vault_monitoring.notifications_enabled ? aws_sns_topic.vault_alerts[*].arn : []
  vault_rpc_host      = var.account_lifecycle == "prd" ? "https://base-mainnet.g.alchemy.com/v2" : "https://base-sepolia.g.alchemy.com/v2"
}

################################################################################
# SNS
################################################################################

resource "aws_sns_topic" "vault_alerts" {
  count    = var.vault_monitoring.create ? 1 : 0
  provider = aws.use1
  name     = "${local.shortname}-vault-alerts-${local.vault_mon_env}"

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Alerts"
    Capability = "Monitoring"
  })
}

################################################################################
# LAMBDA
################################################################################

data "archive_file" "vault_mon" {
  count       = var.vault_monitoring.create ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/07_col_mar_vault_mon.py"
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

resource "aws_lambda_function" "vault_mon" {
  count         = var.vault_monitoring.create ? 1 : 0
  provider      = aws.use1
  function_name = local.vault_mon_name
  description   = "Publishes insurance-fund debt, halt, and backing metrics from the vault subgraph"
  role          = aws_iam_role.vault_mon[0].arn
  handler       = "07_col_mar_vault_mon.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 128

  filename         = data.archive_file.vault_mon[0].output_path
  source_code_hash = data.archive_file.vault_mon[0].output_base64sha256

  environment {
    variables = {
      SUBGRAPH_URL    = var.vault_env.subgraph_url
      VAULT_ADDRESS   = var.vault_env.vault_address
      FUTURES_ADDRESS = var.vault_env.futures_address
      PERPS_ADDRESS   = var.vault_env.perps_address
      ETH_RPC_URL     = "${local.vault_rpc_host}/${var.alchemy_api_key}"
      CW_NAMESPACE    = local.vault_mon_ns
    }
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor"
    Capability = "Monitoring"
  })

  depends_on = [aws_iam_role_policy_attachment.vault_mon_logs]
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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Uncovered Loss"
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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Subgraph Age"
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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

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
  alarm_actions       = local.vault_alert_actions
  ok_actions          = local.vault_alert_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Keeper Errors"
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
              aws_cloudwatch_metric_alarm.vault_util_warn[*].arn,
              aws_cloudwatch_metric_alarm.vault_util_crit[*].arn,
              aws_cloudwatch_metric_alarm.vault_halted[*].arn,
              aws_cloudwatch_metric_alarm.vault_backing_gap[*].arn,
              aws_cloudwatch_metric_alarm.vault_margin_engine_unset[*].arn,
              aws_cloudwatch_metric_alarm.vault_check_success[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_age[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_errors[*].arn,
              aws_cloudwatch_metric_alarm.keeper_unhealthy[*].arn,
              aws_cloudwatch_metric_alarm.keeper_silent[*].arn,
              aws_cloudwatch_metric_alarm.keeper_errors[*].arn,
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
            ]
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
    )
  })
}
