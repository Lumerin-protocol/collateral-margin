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

# foundation-core: titanio-{env}-hpdx-alerts (Slack) / titanio-{env}-hpdx-page (SMS)
data "aws_sns_topic" "hpdx_alerts" {
  count = var.vault_monitoring.create && var.vault_monitoring.dev_alerts_topic_name != "" ? 1 : 0
  name  = var.vault_monitoring.dev_alerts_topic_name
}

data "aws_sns_topic" "hpdx_page" {
  count = var.vault_monitoring.create && var.vault_monitoring.devops_alerts_topic_name != "" ? 1 : 0
  name  = var.vault_monitoring.devops_alerts_topic_name
}

locals {
  vault_mon_env  = substr(var.account_shortname, 8, 3)
  vault_mon_ns   = "ColMarVault"
  vault_mon_name = "${local.shortname}-vault-mon-${local.vault_mon_env}"
  # The hashprice-oracle SPV keeper and its composite alarm, deployed by that repo in this account.
  oracle_keeper_function   = "futures-oracle-update-v2"
  oracle_alarm_arn         = "arn:aws:cloudwatch:${var.default_region}:${var.account_number}:alarm:hpo-oracle-${local.vault_mon_env}"
  vault_slack_topic_arn    = length(data.aws_sns_topic.hpdx_alerts) > 0 ? data.aws_sns_topic.hpdx_alerts[0].arn : ""
  vault_page_topic_arn     = length(data.aws_sns_topic.hpdx_page) > 0 ? data.aws_sns_topic.hpdx_page[0].arn : ""
  vault_critical_topic_arn = var.account_lifecycle == "prd" ? local.vault_page_topic_arn : local.vault_slack_topic_arn
  # Empty until notifications_enabled. Warning is Slack. Critical is Slack in
  # dev and the phone topic when account_lifecycle is prd.
  vault_warning_actions  = var.vault_monitoring.notifications_enabled && local.vault_slack_topic_arn != "" ? [local.vault_slack_topic_arn] : []
  vault_critical_actions = var.vault_monitoring.notifications_enabled && local.vault_critical_topic_arn != "" ? [local.vault_critical_topic_arn] : []
  vault_rpc_host         = var.account_lifecycle == "prd" ? "https://base-mainnet.g.alchemy.com/v2" : "https://base-sepolia.g.alchemy.com/v2"
  vault_btc_rpc_url      = var.bitcoin_rpc_url != "" ? var.bitcoin_rpc_url : "https://bitcoin-mainnet.g.alchemy.com/v2/${var.alchemy_api_key}"
  # Days before the Bitcoin halving at which a reminder fires, and its severity.
  # 500 and 495 are temporary, to see the alarms fire (about 503 days out on 2026-10-31).
  # 24 h price moves as a fraction of the PME MM spot shock (read on-chain, so
  # the thresholds follow setShocks). BTC/USD is already inside hashprice USD,
  # so its alarms are warnings.
  price_move_alarms = {
    "hashprice-warn" = { metric = "HashpriceChange24hPct", ratio = 0.5, severity = "warning" }
    "hashprice-crit" = { metric = "HashpriceChange24hPct", ratio = 1, severity = "critical" }
    "btc-warn"       = { metric = "BtcChange24hPct", ratio = 0.5, severity = "warning" }
    "btc-crit"       = { metric = "BtcChange24hPct", ratio = 1, severity = "warning" }
  }
  # Feed age above which the price is treated as frozen. Hashprice updates per
  # Bitcoin block, and hour-long gaps between blocks happen every few days.
  price_feed_age_alarms = {
    "hashprice" = { metric = "HashpriceFeedAgeSeconds", seconds = 7200 }
    "btc-usd"   = { metric = "BtcUsdFeedAgeSeconds", seconds = 3600 }
  }
  # Subgraphs watched for lag and indexing errors beyond the vault one. Futures
  # and derivatives feed the UI's positions and orders; the market maker reads
  # oracles only to backfill volatility at startup.
  watched_subgraphs = {
    "futures"     = { title = "Futures", severity = "critical" }
    "derivatives" = { title = "Derivatives", severity = "critical" }
    "oracles"     = { title = "Hashprice oracle", severity = "warning" }
  }
  btc_halving_reminders = { "500" = "warning", "495" = "warning", "30" = "warning", "14" = "warning", "7" = "warning", "2" = "critical", "1" = "critical" }
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
      VAULT_SUBGRAPH_URL            = var.vault_env.subgraph_url
      POINTS_SUBGRAPH_URL           = var.vault_env.points_subgraph_url
      FUTURES_SUBGRAPH_URL          = var.vault_env.futures_subgraph_url
      DERIVATIVES_SUBGRAPH_URL      = var.vault_env.derivatives_subgraph_url
      HASHPRICE_ORACLE_SUBGRAPH_URL = var.vault_env.oracles_subgraph_url
      VAULT_ADDRESS                 = var.vault_env.vault_address
      FUTURES_ADDRESS               = var.vault_env.futures_address
      PERPS_ADDRESS                 = var.vault_env.perps_address
      MM_ADDRESS                    = var.vault_env.mm_address
      MM_FUTURES_MARKETS            = tostring(var.vault_monitoring.mm_futures_markets)
      MM_HEALTH_URL                 = local.vault_mm_health_url
      ETH_RPC_URL                   = "${local.vault_rpc_host}/${var.alchemy_api_key}"
      BITCOIN_RPC_URL               = local.vault_btc_rpc_url
      CW_NAMESPACE                  = local.vault_mon_ns
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

resource "aws_cloudwatch_metric_alarm" "vault_backstop_loss" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backstop-loss-${local.vault_mon_env}"
  alarm_description   = "Protocol backstop equity is below -${var.vault_monitoring.backstop_loss_crit_usd} USD: its parked positions are losing enough to take a real bite out of the insurance fund once they unwind or settle. Check the keeper unwinder, widen the band with setBackstopParams (past the BackstopUnwindBudgetBps budget if deleveraging is cheaper than holding), or unwind by hand, and prepare a depositInsuranceFund top-up. See docs/protocol-liquidation-exposure.md#operating-the-backstop."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackstopEquity"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = -var.vault_monitoring.backstop_loss_crit_usd
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backstop Loss"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_backstop_notional" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backstop-notional-${local.vault_mon_env}"
  alarm_description   = "Protocol backstop exposure at the mark (BackstopNotional, both venues) is above ${var.vault_monitoring.backstop_notional_warn_usd} USD: a large liquidation was handed to the backstop. Watch BackstopEquity, confirm the keeper unwinder is filling, and widen the band with setBackstopParams up to the BackstopUnwindBudgetBps budget if the book is not taking it. See docs/protocol-liquidation-exposure.md#operating-the-backstop. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackstopNotional"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.backstop_notional_warn_usd
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backstop Notional"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_backstop_over_budget" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backstop-over-budget-${local.vault_mon_env}"
  alarm_description   = "The vault's backstop unwind band + caller fee is above the liquidation fee a venue keeps (liquidationFeeBps x (1 - liquidatorShareBps), BackstopUnwindBudgetBps). An unwind then gives away more than the liquidation earned, and anyone can profit by liquidating and unwinding against themselves (X3-R3A-2). Expected only while deliberately deleveraging; otherwise lower it with setBackstopParams. See docs/protocol-liquidation-exposure.md#operating-the-backstop. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BackstopUnwindOverBudgetBps"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backstop Over Budget"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_backstop_unfilled" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-backstop-unfilled-${local.vault_mon_env}"
  alarm_description   = "The protocol backstop has held an open leg for 6 hours: the book is not taking it inside the unwind band. Check the keeper unwinder is running, then widen the band with setBackstopParams in steps up to the BackstopUnwindBudgetBps budget (past it only to deleverage deliberately). See docs/protocol-liquidation-exposure.md#operating-the-backstop. Warning only."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 6
  metric_name         = "BackstopOpenLegs"
  namespace           = local.vault_mon_ns
  period              = 3600
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Backstop Unfilled"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "btc_halving" {
  for_each            = var.vault_monitoring.create ? local.btc_halving_reminders : {}
  provider            = aws.use1
  alarm_name          = "${local.shortname}-btc-halving-${each.key}d-${local.vault_mon_env}"
  alarm_description   = "The Bitcoin halving is about ${each.key} day(s) away (BtcDaysUntilHalving, from the average block time over the last 2,016 blocks; BtcBlocksUntilHalving is exact). It halves the subsidy part of hashprice in one block, far beyond the MM shock: raise margin requirements on the published schedule (CF-321) with setShocks, and check futures expiries that straddle it. Fires once per halving; ${each.value == "critical" ? "pages on lmn" : "warning only"}."
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "BtcDaysUntilHalving"
  namespace           = local.vault_mon_ns
  period              = 3600
  statistic           = "Minimum"
  threshold           = tonumber(each.key)
  treat_missing_data  = "ignore"
  alarm_actions       = each.value == "critical" ? local.vault_critical_actions : local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar BTC Halving ${each.key}d"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "price_move" {
  for_each            = var.vault_monitoring.create ? local.price_move_alarms : {}
  provider            = aws.use1
  alarm_name          = "${local.shortname}-price-move-${each.key}-${local.vault_mon_env}"
  alarm_description   = "${each.value.metric} moved at least ${each.value.ratio * 100}% of the MM spot shock in 24 h (|change| / MmSpotShockPct >= ${each.value.ratio}). A move the size of the MM shock puts the most levered accounts at liquidation: check the keeper is liquidating, the insurance fund and backstop exposure, and whether to raise margins with setShocks. ${each.value.severity == "critical" ? "Pages on lmn." : "Warning only."}"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = each.value.ratio
  treat_missing_data  = "ignore"
  alarm_actions       = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions
  ok_actions          = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions

  metric_query {
    id = "change"
    metric {
      metric_name = each.value.metric
      namespace   = local.vault_mon_ns
      period      = 300
      stat        = "Average"
    }
  }

  metric_query {
    id = "mm"
    metric {
      metric_name = "MmSpotShockPct"
      namespace   = local.vault_mon_ns
      period      = 300
      stat        = "Maximum"
    }
  }

  metric_query {
    id          = "ratio"
    expression  = "ABS(change) / mm"
    label       = "24 h move / MM shock"
    return_data = true
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Price Move ${each.key}"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "price_feed_age" {
  for_each            = var.vault_monitoring.create ? local.price_feed_age_alarms : {}
  provider            = aws.use1
  alarm_name          = "${local.shortname}-price-feed-age-${each.key}-${local.vault_mon_env}"
  alarm_description   = "${each.value.metric} is above ${each.value.seconds / 60} minutes: the feed looks frozen, which hides price moves from margin and from the move alarms. Check the hashprice oracle keeper and the Chainlink BTC/USD feed. Warning only."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = each.value.metric
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = each.value.seconds
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Price Feed Age ${each.key}"
    Capability = "Monitoring"
  })
}

# The oracle repo's hpo-oracle page measures the same lag through the keeper's
# own Bitcoin node, so a stuck node makes the relay look current there. This
# one takes the tip most of Alchemy and five public explorers agree on.
resource "aws_cloudwatch_metric_alarm" "spv_behind_bitcoin" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-spv-behind-bitcoin-${local.vault_mon_env}"
  alarm_description   = "The hashprice oracle trails the Bitcoin tip by 2 or more blocks for 15 minutes, by the tip most of Alchemy and the public explorers agree on. If hpo-oracle-${local.vault_mon_env} is OK, the keeper's Bitcoin node is stuck and the keeper does not see the new blocks: check its logs and its BITCOIN_RPC_URL. The venues and the margin engine reject the price once it is older than MAX_ORACLE_STALENESS."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  metric_name         = "SpvBlocksBehind"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Minimum"
  threshold           = 2
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar SPV Behind Bitcoin"
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

resource "aws_cloudwatch_metric_alarm" "vault_partial_check" {
  count               = var.vault_monitoring.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-partial-check-${local.vault_mon_env}"
  alarm_description   = "A best-effort read in the vault monitor (points subgraph, market maker, /health, Bitcoin node, price feeds) failed on every run for 15 minutes, so its metrics and alarms are blind. The failed checks are listed as failed= in the Lambda's ok line. Warning only."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "PartialCheckFailures"
  namespace           = local.vault_mon_ns
  period              = 900
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "ignore"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Partial Check"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "vault_mon_lambda" {
  for_each            = var.vault_monitoring.create ? toset(["Errors", "Throttles"]) : toset([])
  provider            = aws.use1
  alarm_name          = "${local.shortname}-vault-mon-lambda-${lower(each.key)}-${local.vault_mon_env}"
  alarm_description   = "The vault monitor Lambda reported ${each.key} (a crash, timeout or out-of-memory, or a throttled invocation). A failed check alone does not count here: the handler catches it and CheckSuccess reports it. Read /aws/lambda/${local.vault_mon_name}. Warning only; CheckSuccess pages if runs stop succeeding."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = each.key
  namespace           = "AWS/Lambda"
  dimensions          = { FunctionName = local.vault_mon_name }
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Vault Monitor Lambda ${each.key}"
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

resource "aws_cloudwatch_metric_alarm" "watched_subgraph_behind" {
  for_each            = var.vault_monitoring.create ? local.watched_subgraphs : {}
  provider            = aws.use1
  alarm_name          = "${local.shortname}-${each.key}-subgraph-behind-${local.vault_mon_env}"
  alarm_description   = "${each.value.title} subgraph is more than ${var.vault_monitoring.max_subgraph_age_minutes} minutes of blocks behind the chain head. The tag is still indexing or stalled, so the UI and anything reading it show stale data. Check goldsky subgraph log --filter error."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphBlocksBehind"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = var.vault_monitoring.max_subgraph_age_minutes * 30
  treat_missing_data  = "ignore"
  dimensions          = { Subgraph = each.key }
  alarm_actions       = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions
  ok_actions          = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar ${each.value.title} Subgraph Behind"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "watched_subgraph_errors" {
  for_each            = var.vault_monitoring.create ? merge({ "points" = { title = "Points", severity = "critical" } }, local.watched_subgraphs) : {}
  provider            = aws.use1
  alarm_name          = "${local.shortname}-${each.key}-subgraph-errors-${local.vault_mon_env}"
  alarm_description   = "${each.value.title} subgraph reports indexing errors (_meta.hasIndexingErrors). A handler failed; the subgraph stops or skips data. Check goldsky subgraph log --filter error, fix the mapping and redeploy."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "SubgraphIndexingErrors"
  namespace           = local.vault_mon_ns
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "ignore"
  dimensions          = { Subgraph = each.key }
  alarm_actions       = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions
  ok_actions          = each.value.severity == "critical" ? local.vault_critical_actions : local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar ${each.value.title} Subgraph Errors"
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
  alarm_description   = "Keeper logged an error (pino level 50). Sweeps that throw skip liquidation for that cycle. \"account health read failed\" means the margin engine reverts for that user (a venue getRiskView fails), so the account cannot trade, withdraw or be liquidated until the venue is fixed. Read /ecs/col-mar-keeper logs, restart if the loop is stuck, then top up any uncovered loss."
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

  # Sections in order of importance: price feed, vault, market maker, indexers, monitoring.
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
            title  = "Alarm Status"
            sortBy = "stateUpdatedTimestamp"
            alarms = concat(
              [local.oracle_alarm_arn],
              aws_cloudwatch_metric_alarm.vault_uncovered_loss[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_equity[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_loss[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_notional[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_over_budget[*].arn,
              aws_cloudwatch_metric_alarm.vault_backstop_unfilled[*].arn,
              [for alarm in aws_cloudwatch_metric_alarm.btc_halving : alarm.arn],
              [for alarm in aws_cloudwatch_metric_alarm.price_move : alarm.arn],
              [for alarm in aws_cloudwatch_metric_alarm.price_feed_age : alarm.arn],
              aws_cloudwatch_metric_alarm.spv_behind_bitcoin[*].arn,
              aws_cloudwatch_metric_alarm.vault_util_warn[*].arn,
              aws_cloudwatch_metric_alarm.vault_util_crit[*].arn,
              aws_cloudwatch_metric_alarm.vault_halted[*].arn,
              aws_cloudwatch_metric_alarm.vault_backing_gap[*].arn,
              aws_cloudwatch_metric_alarm.vault_margin_engine_unset[*].arn,
              aws_cloudwatch_metric_alarm.vault_check_success[*].arn,
              aws_cloudwatch_metric_alarm.vault_partial_check[*].arn,
              [for alarm in aws_cloudwatch_metric_alarm.vault_mon_lambda : alarm.arn],
              aws_cloudwatch_metric_alarm.vault_subgraph_age[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_behind[*].arn,
              aws_cloudwatch_metric_alarm.points_subgraph_behind[*].arn,
              aws_cloudwatch_metric_alarm.vault_subgraph_errors[*].arn,
              [for alarm in aws_cloudwatch_metric_alarm.watched_subgraph_behind : alarm.arn],
              [for alarm in aws_cloudwatch_metric_alarm.watched_subgraph_errors : alarm.arn],
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
              aws_cloudwatch_composite_alarm.futures_mm_unhealthy[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_error_logged[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_warnings[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_halt[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_no_tick[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_tick_error[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_cancel_fail[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_error_rate[*].arn,
              aws_cloudwatch_metric_alarm.futures_mm_multicall_fail[*].arn,
            )
          }
        },
        {
          type       = "text"
          x          = 0
          y          = 4
          width      = 24
          height     = 4
          properties = { markdown = "## Price feed: nothing trades without it\n- Hashprice USD = hashprice BTC from our SPV oracle (Bitcoin headers relayed by the SPV keeper) × Chainlink BTC/USD. Margin, marks, liquidations and the market maker all read it.\n- **SPV relay delay**: Bitcoin blocks the oracle trails the tip, and minutes since the keeper's last header. **Chainlink BTC/USD**: minutes since its last update (each drop to 0 is an update) and updates per hour. On dev BTC/USD is a mock the SPV keeper updates.\n- **Price feed age**: the hashprice feed reports the older of its two inputs, so it rises when either stalls. **Moves vs MM spot shock**: a 24 h hashprice move of half the shock warns, the full shock pages." }
        },
        {
          type   = "metric"
          x      = 0
          y      = 8
          width  = 12
          height = 6
          properties = {
            title  = "Hashprice and BTC (USD)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "HashpriceUsd", { label = "Hashprice (USD/PH/day)" }],
              [local.vault_mon_ns, "BtcUsd", { label = "BTC (right)", yAxis = "right" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 8
          width  = 12
          height = 6
          properties = {
            title  = "SPV relay delay"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "SpvBlocksBehind", { label = "Blocks behind the Bitcoin tip", stat = "Maximum" }],
              [{ expression = "spv / 60", id = "spvmin", label = "Minutes since the last header (right)", yAxis = "right" }],
              [local.vault_mon_ns, "SpvFeedAgeSeconds", { id = "spv", stat = "Maximum", visible = false }],
            ]
            yAxis = { left = { min = 0 }, right = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 14
          width  = 8
          height = 6
          properties = {
            title  = "Chainlink BTC/USD updates"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "btc / 60", id = "btcmin", label = "Minutes since the last update" }],
              [local.vault_mon_ns, "BtcUsdFeedAgeSeconds", { id = "btc", stat = "Maximum", visible = false }],
              [local.vault_mon_ns, "BtcUsdUpdates1h", { label = "Updates in the last hour (right)", stat = "Maximum", yAxis = "right" }],
            ]
            yAxis = { left = { min = 0 }, right = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 14
          width  = 8
          height = 6
          properties = {
            title  = "SPV keeper (header relayer)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              ["AWS/Lambda", "Invocations", "FunctionName", local.oracle_keeper_function, { label = "Runs", stat = "Sum" }],
              [var.vault_monitoring.oracle_metric_namespace, "oracle_job_completions", { label = "Completed", stat = "Sum" }],
              ["AWS/Lambda", "Errors", "FunctionName", local.oracle_keeper_function, { label = "Lambda errors", stat = "Sum", color = "#d62728" }],
              [var.vault_monitoring.oracle_metric_namespace, "oracle_lambda_errors", { label = "Logged errors", stat = "Sum", color = "#ff7f0e" }],
              ["AWS/Lambda", "Throttles", "FunctionName", local.oracle_keeper_function, { label = "Throttles", stat = "Sum" }],
              ["AWS/Lambda", "Duration", "FunctionName", local.oracle_keeper_function, { label = "Max duration ms (right)", stat = "Maximum", yAxis = "right" }],
            ]
            yAxis = { left = { min = 0 }, right = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 14
          width  = 8
          height = 6
          properties = {
            title  = "Price feed age (minutes)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "hp / 60", id = "hpmin", label = "Hashprice feed" }],
              [{ expression = "btcage / 60", id = "btcagemin", label = "BTC/USD feed" }],
              [local.vault_mon_ns, "HashpriceFeedAgeSeconds", { id = "hp", stat = "Maximum", visible = false }],
              [local.vault_mon_ns, "BtcUsdFeedAgeSeconds", { id = "btcage", stat = "Maximum", visible = false }],
              [var.vault_monitoring.oracle_metric_namespace, "oracle_data_age_minutes", "Environment", local.vault_mon_env, { label = "Hashprice oracle data" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 20
          width  = 12
          height = 6
          properties = {
            title  = "Price moves vs MM spot shock (%)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "HashpriceChange24hPct", { label = "Hashprice 24 h" }],
              [local.vault_mon_ns, "HashpriceChange1hPct", { label = "Hashprice 1 h" }],
              [local.vault_mon_ns, "BtcChange24hPct", { label = "BTC 24 h" }],
              [local.vault_mon_ns, "BtcChange1hPct", { label = "BTC 1 h" }],
              [local.vault_mon_ns, "MmSpotShockPct", { label = "MM shock", stat = "Maximum", color = "#d62728" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 20
          width  = 12
          height = 6
          properties = {
            title  = "Days until the Bitcoin halving"
            region = var.default_region
            period = 3600
            view   = "singleValue"
            metrics = [
              [local.vault_mon_ns, "BtcDaysUntilHalving", { label = "Days", stat = "Minimum" }],
              [local.vault_mon_ns, "BtcBlocksUntilHalving", { label = "Blocks", stat = "Minimum" }],
            ]
          }
        },
        {
          type   = "log"
          x      = 0
          y      = 26
          width  = 24
          height = 6
          properties = {
            title  = "SPV keeper recent errors and warnings"
            region = var.default_region
            view   = "table"
            query  = "SOURCE '/aws/lambda/${local.oracle_keeper_function}' | fields @timestamp, msg, component, coalesce(err.message, message, '') as detail | filter level >= 40 | sort @timestamp desc | limit 50"
          }
        },
        {
          type       = "text"
          x          = 0
          y          = 32
          width      = 24
          height     = 4
          properties = { markdown = "## Vault: solvency, liquidations and backstop\n- **Halted**: 1 while the vault is halted or the margin engine is unset. **Debt**: what the insurance fund owes after covering traders' losses; *uncovered loss* above 0 is a loss nothing covers (top up with depositInsuranceFund). **Utilization**: debt as a share of the cap; a breach halts the vault.\n- **Backing gap**: supply minus debt minus USDC held; above 0 the vault is short. **Balances available for a top-up**: insurance fund and venue fees. **Keeper**: liquidation sweeps; if they stop, nobody liquidates.\n- **Protocol backstop**: positions taken over from liquidations; equity below 0 is a loss forming. **Offload**: what an unwind may give away (band + fee); above the kept liquidation fee, unwinds cost the vault." }
        },
        {
          type   = "metric"
          x      = 0
          y      = 36
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
          x      = 6
          y      = 36
          width  = 9
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
          x      = 15
          y      = 36
          width  = 9
          height = 6
          properties = {
            title  = "Utilization %"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "InsuranceDebtUtilizationPct", { label = "Debt / cap" }],
            ]
            yAxis = { left = { min = 0 } }
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
          x      = 0
          y      = 42
          width  = 12
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
          x      = 12
          y      = 42
          width  = 12
          height = 6
          properties = {
            title  = "Balances available for a top-up (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "InsuranceFundBalance", { label = "Insurance fund" }],
              [local.vault_mon_ns, "FuturesFeeBalance", { label = "Futures fees (right)", yAxis = "right" }],
              [local.vault_mon_ns, "PerpsFeeBalance", { label = "Perps fees (right)", yAxis = "right" }],
            ]
            yAxis = { left = { min = 0 }, right = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 48
          width  = 8
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
          x      = 16
          y      = 48
          width  = 8
          height = 6
          properties = {
            title  = "Protocol backstop exposure at the mark (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackstopNotional", { label = "Total", stat = "Maximum" }],
              [{ expression = "SEARCH('{${local.vault_mon_ns},Venue} MetricName=\"BackstopNotional\"', 'Maximum', 300)", id = "venues", label = "" }],
            ]
            annotations = { horizontal = [{ label = "warn", value = var.vault_monitoring.backstop_notional_warn_usd }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 54
          width  = 12
          height = 6
          properties = {
            title  = "Protocol backstop exposure (raw units)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackstopFuturesNetQuantity", { label = "Futures net contracts" }],
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BackstopFuturesNetQuantity\"', 'Average', 300))", id = "legs", label = "$${PROP('Dim.Market')}" }],
              [local.vault_mon_ns, "BackstopPerpsNetQuantity", { label = "Perps net (1e6)" }],
              [local.vault_mon_ns, "BackstopOpenLegs", { label = "Open legs", stat = "Maximum" }],
            ]
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 54
          width  = 12
          height = 6
          properties = {
            title  = "Backstop offload: unwind band + fee vs kept liquidation fee (bps)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "BackstopUnwindBandBps", { label = "Band", stat = "Maximum" }],
              [local.vault_mon_ns, "BackstopUnwindFeeBps", { label = "Caller fee", stat = "Maximum" }],
              [local.vault_mon_ns, "BackstopUnwindOverBudgetBps", { label = "Over budget", stat = "Maximum" }],
              [{ expression = "SEARCH('{${local.vault_mon_ns},Venue} MetricName=\"BackstopUnwindBudgetBps\"', 'Minimum', 300)", id = "budget", label = "Budget" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type       = "text"
          x          = 0
          y          = 66
          width      = 24
          height     = 4
          properties = { markdown = "## Market maker: one MM quoting futures and perps\n- **State** and **own orders** come from its /health: running, quarantined or paused markets, seconds since its last loop. **Book levels**: price levels per side of every live book; 0 on a side means a one-sided book.\n- **Spread** and **mid drift** from the mark show stale quotes. **Position, collateral, utilization, ETH**: inventory against its caps, IM against its vault balance, and gas money.\n- **Loop**, **execution**, **warnings** and **recent errors** come from its logs." }
        },
        {
          type   = "metric"
          x      = 8
          y      = 70
          width  = 8
          height = 6
          properties = {
            title  = "Book levels by market (bids / asks)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookBidLevels\"', 'Minimum', 300))", id = "bids", label = "$${PROP('Dim.Market')}-bids" }],
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookAskLevels\"', 'Minimum', 300))", id = "asks", label = "$${PROP('Dim.Market')}-asks" }],
              [local.vault_mon_ns, "BookMinSideLevels", { label = "Emptiest side", stat = "Minimum", color = "#d62728" }],
            ]
            annotations = { horizontal = [{ label = "one-sided", value = 1 }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 0
          y      = 76
          width  = 8
          height = 6
          properties = {
            title  = "Top-of-book spread (bps)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookSpreadBps\"', 'Maximum', 300))", id = "spread", label = "$${PROP('Dim.Market')}" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 76
          width  = 8
          height = 6
          properties = {
            title  = "Book mid drift from mark (bps)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookMidDriftBps\"', 'Maximum', 300))", id = "drift", label = "$${PROP('Dim.Market')}" }],
            ]
            annotations = { horizontal = [{ label = "stale", value = var.vault_monitoring.book_drift_warn_bps }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 76
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker position notional (USDC)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"MmPositionNotional\"', 'Maximum', 300))", id = "pos", label = "$${PROP('Dim.Market')}" }],
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
          y      = 82
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
          y      = 82
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
          y      = 82
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
          type       = "text"
          x          = 0
          y          = 100
          width      = 24
          height     = 2
          properties = { markdown = "## Indexers\n- Goldsky subgraphs: blocks behind the chain head and indexing-error flags. The UI reads positions and orders from futures and derivatives; the market maker backfills volatility from the oracle subgraph." }
        },
        {
          type   = "metric"
          x      = 0
          y      = 102
          width  = 12
          height = 6
          properties = {
            title  = "Subgraph blocks behind the chain head"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "SEARCH('{${local.vault_mon_ns},Subgraph} MetricName=\"SubgraphBlocksBehind\"', 'Maximum', 300)", id = "behind", label = "" }],
            ]
            annotations = { horizontal = [{ label = "behind", value = var.vault_monitoring.max_subgraph_age_minutes * 30 }] }
            yAxis       = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 12
          y      = 102
          width  = 12
          height = 6
          properties = {
            title  = "Subgraph indexing errors and vault data age"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.vault_mon_ns, "SubgraphIndexingErrors", { label = "vault", stat = "Maximum" }],
              [{ expression = "SEARCH('{${local.vault_mon_ns},Subgraph} MetricName=\"SubgraphIndexingErrors\"', 'Maximum', 300)", id = "errors", label = "" }],
              [local.vault_mon_ns, "SubgraphDataAgeSeconds", { label = "Vault data age (s)", stat = "Maximum", yAxis = "right" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type       = "text"
          x          = 0
          y          = 108
          width      = 24
          height     = 2
          properties = { markdown = "## Monitoring\n- Everything here is 0 while the monitor is healthy. *Run failed or missing* at 1 means the last 5 minutes have no fresh data, so every chart above is stale; the other lines say which reads failed." }
        },
        {
          type   = "metric"
          x      = 0
          y      = 110
          width  = 24
          height = 6
          properties = {
            title  = "Monitor failures (0 = healthy)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "1 - FILL(ok, 0)", id = "runfail", label = "Run failed or missing", color = "#d62728" }],
              [{ expression = "1 - market", id = "marketfail", label = "Market check failed" }],
              [{ expression = "1 - health", id = "healthfail", label = "MM /health failed" }],
              [local.vault_mon_ns, "CheckSuccess", { id = "ok", stat = "Minimum", visible = false }],
              [local.vault_mon_ns, "MarketCheckSuccess", { id = "market", stat = "Minimum", visible = false }],
              [local.vault_mon_ns, "MmHealthCheckSuccess", { id = "health", stat = "Minimum", visible = false }],
              [local.vault_mon_ns, "PartialCheckFailures", { label = "Failed partial checks", stat = "Maximum", color = "#d62728" }],
              ["AWS/Lambda", "Errors", "FunctionName", local.vault_mon_name, { label = "Lambda errors", stat = "Sum" }],
              ["AWS/Lambda", "Throttles", "FunctionName", local.vault_mon_name, { label = "Lambda throttles", stat = "Sum" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
      ],
      [for widget in [
        {
          type   = "metric"
          x      = 0
          y      = 48
          width  = 8
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
        {
          type   = "log"
          x      = 0
          y      = 60
          width  = 24
          height = 6
          properties = {
            title  = "Keeper recent errors and warnings"
            region = var.default_region
            view   = "table"
            query  = "SOURCE '${one(aws_cloudwatch_log_group.keeper_use1[*].name)}' | fields @timestamp, msg, coalesce(err.message, message, '') as detail | filter level >= 40 | sort @timestamp desc | limit 50"
          }
        },
      ] : widget if var.keeper_service.create],
      # The market maker (one portfolio app quoting futures and perps), from its log metric filters.
      [for widget in [
        {
          type   = "metric"
          x      = 0
          y      = 88
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker loop (5m)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.futures_mm_metric_ns, "TickCount", { label = "Ticks", stat = "Sum", color = "#2ca02c" }],
              [local.futures_mm_metric_ns, "TickErrorCount", { label = "Tick errors", stat = "Sum", color = "#d62728" }],
              [local.futures_mm_metric_ns, "HaltCount", { label = "HALTs", stat = "Sum", color = "#8c564b" }],
              [local.futures_mm_metric_ns, "ErrorCount", { label = "Errors", stat = "Sum", color = "#ff7f0e" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 8
          y      = 88
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker execution (5m)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.futures_mm_metric_ns, "MulticallExecuted", { label = "Multicalls executed", stat = "Sum", color = "#2ca02c" }],
              [local.futures_mm_metric_ns, "MulticallFailed", { label = "Multicalls failed", stat = "Sum", color = "#d62728" }],
              [local.futures_mm_metric_ns, "OrderMatched", { label = "Fills", stat = "Sum", color = "#1f77b4" }],
              [local.futures_mm_metric_ns, "CancelAllTriggered", { label = "Cancel all", stat = "Sum", color = "#ff7f0e" }],
              [local.futures_mm_metric_ns, "CancelAllFailed", { label = "Cancel all failed", stat = "Sum", color = "#9467bd" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 88
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker warnings and failures (5m)"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [local.futures_mm_metric_ns, "WarnCount", { label = "Warnings", stat = "Sum", color = "#ff7f0e" }],
              [local.futures_mm_metric_ns, "GasThrottleCount", { label = "Gas throttle", stat = "Sum", color = "#9467bd" }],
              [local.futures_mm_metric_ns, "PriceFeedFailed", { label = "Price feed failed", stat = "Sum", color = "#d62728" }],
              [local.futures_mm_metric_ns, "InitRetryCount", { label = "Init retries", stat = "Sum", color = "#8c564b" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "log"
          x      = 0
          y      = 94
          width  = 24
          height = 6
          properties = {
            title  = "Market-maker recent errors and warnings"
            region = var.default_region
            view   = "table"
            query  = "SOURCE '${one(aws_cloudwatch_log_group.futures_mm_use1[*].name)}' | fields @timestamp, msg, component, coalesce(err.message, message, '') as detail | filter level >= 40 | sort @timestamp desc | limit 50"
          }
        },
      ] : widget if var.futures_mm_service.create],
      [for widget in [
        {
          type   = "metric"
          x      = 0
          y      = 70
          width  = 8
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
              [local.vault_mon_ns, "MmTickAgeSeconds", { label = "Tick age (s)", stat = "Maximum", yAxis = "right" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
        {
          type   = "metric"
          x      = 16
          y      = 70
          width  = 8
          height = 6
          properties = {
            title  = "Market-maker own orders by market"
            region = var.default_region
            period = 300
            view   = "timeSeries"
            metrics = [
              [{ expression = "REMOVE_EMPTY(SEARCH('{${local.vault_mon_ns},Market} MetricName=\"MmOwnOrders\"', 'Minimum', 300))", id = "orders", label = "$${PROP('Dim.Market')}" }],
              [local.vault_mon_ns, "MmMinOwnOrders", { label = "Fewest", stat = "Minimum", color = "#d62728" }],
            ]
            yAxis = { left = { min = 0 } }
          }
        },
      ] : widget if local.vault_mm_health],
    )
  })
}
