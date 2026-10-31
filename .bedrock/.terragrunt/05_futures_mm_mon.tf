################################################################################
# MARKET MAKER — MONITORING
# Metric filters and alarms for the market maker ECS service. There is one
# market maker (the portfolio app) and it quotes on both venues, futures and
# perps; the `futures_mm` names are historical.
# The portfolio runner logs "portfolio tick" once per successful loop.
# Component alarms do not notify. The composite does, plus the error and
# warning log alarms, which use the shared alert topics like the keeper.
################################################################################

locals {
  futures_mm_metric_ns = "ColMarFuturesMM"
}

################################################################################
# SNS TOPIC
################################################################################

resource "aws_sns_topic" "futures_mm_alerts" {
  count    = var.futures_mm_service.create ? 1 : 0
  provider = aws.use1
  name     = "${local.shortname}-futures-mm-alerts-${local.futures_mm_env_suffix}"

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Alerts"
    Capability = "Monitoring"
  })
}

################################################################################
# METRIC FILTERS - EVENT COUNTS
################################################################################

resource "aws_cloudwatch_log_metric_filter" "futures_mm_halt_count" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-halt-count"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"HALT:*\" }"

  metric_transformation {
    name      = "HaltCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_error_count" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-error-count"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.level = 50 }"

  metric_transformation {
    name      = "ErrorCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_warn_count" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-warn-count"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.level = 40 }"

  metric_transformation {
    name      = "WarnCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_tick_count" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-tick-count"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"portfolio tick\" }"

  metric_transformation {
    name      = "TickCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_tick_error" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-tick-error"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"tick error\" }"

  metric_transformation {
    name      = "TickErrorCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_gas_throttle" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-gas-throttle"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"throttled:*\" }"

  metric_transformation {
    name      = "GasThrottleCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_multicall_ok" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-multicall-ok"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"multicall batch executed\" }"

  metric_transformation {
    name      = "MulticallExecuted"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_multicall_fail" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-multicall-fail"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"multicall batch failed\" }"

  metric_transformation {
    name      = "MulticallFailed"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_cancel_all_fail" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-cancel-all-fail"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"cancel-all multicall failed\" }"

  metric_transformation {
    name      = "CancelAllFailed"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_order_matched" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-order-matched"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"own order matched\" }"

  metric_transformation {
    name      = "OrderMatched"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_price_feed_fail" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-price-feed-fail"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"ETH price feed read failed\" }"

  metric_transformation {
    name      = "PriceFeedFailed"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_init_retry" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-init-retry"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"initialization failed, retrying\" }"

  metric_transformation {
    name      = "InitRetryCount"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "futures_mm_cancel_all_triggered" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-futures-mm-cancel-all-triggered"
  log_group_name = aws_cloudwatch_log_group.futures_mm_use1[0].name
  pattern        = "{ $.msg = \"cancelling all orders\" }"

  metric_transformation {
    name      = "CancelAllTriggered"
    namespace = local.futures_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# Balances, positions, and book depth come from the vault monitor
# (07_col_mar_vault_mon.tf), which reads them on-chain. The portfolio app logs
# "portfolio tick" without those fields, so log filters cannot supply them.
################################################################################

################################################################################
# ALARMS
################################################################################

# CRITICAL - Market maker halted (collateral or daily loss limit)
resource "aws_cloudwatch_metric_alarm" "futures_mm_halt" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-halt-${local.futures_mm_env_suffix}"
  alarm_description   = "Market maker emitted a HALT event - quoting stopped on both venues (futures and perps)"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HaltCount"
  namespace           = local.futures_mm_metric_ns
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM HALT Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - No heartbeat for 5 minutes (service is down or stuck)
resource "aws_cloudwatch_metric_alarm" "futures_mm_no_tick" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-no-tick-${local.futures_mm_env_suffix}"
  alarm_description   = "No portfolio tick logs for 5+ minutes - the market maker may be down, so neither venue is quoted"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "TickCount"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM No Tick Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Main loop crashing repeatedly
resource "aws_cloudwatch_metric_alarm" "futures_mm_tick_error" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-tick-error-${local.futures_mm_env_suffix}"
  alarm_description   = "Tick errors repeating - the market maker main loop (both venues) is failing"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "TickErrorCount"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Tick Error Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Cannot cancel orders (exposed position)
resource "aws_cloudwatch_metric_alarm" "futures_mm_cancel_fail" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-cancel-fail-${local.futures_mm_env_suffix}"
  alarm_description   = "Cancel-all multicall failed - market maker orders stuck on-chain (check both futures and perps books)"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "CancelAllFailed"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Cancel Failure Alarm"
    Capability = "Monitoring"
  })
}

# Error and warning log alerts, routed like the keeper's (07_col_mar_vault_mon.tf):
# any error notifies the critical topic (Slack on dev, page on prd); a sustained
# run of warnings notifies Slack only. One-off warnings stay on the dashboard.
resource "aws_cloudwatch_metric_alarm" "futures_mm_error_logged" {
  count               = var.vault_monitoring.create && var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-error-logged-${local.futures_mm_env_suffix}"
  alarm_description   = "Market maker logged an error (pino level 50). Read its ECS logs; check quotes and inventory on both venues (futures and perps)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.vault_critical_actions
  ok_actions          = local.vault_critical_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Error Logged"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "futures_mm_warnings" {
  count               = var.vault_monitoring.create && var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-warnings-${local.futures_mm_env_suffix}"
  alarm_description   = "Market maker logged 20+ warnings (pino level 40) in 15 minutes, e.g. throttling, cancel-all or init retries. Read its ECS logs."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "WarnCount"
  namespace           = local.futures_mm_metric_ns
  period              = 900
  statistic           = "Sum"
  threshold           = 20
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.vault_warning_actions
  ok_actions          = local.vault_warning_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Warnings"
    Capability = "Monitoring"
  })
}

# WARNING - Elevated error rate
resource "aws_cloudwatch_metric_alarm" "futures_mm_error_rate" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-errors-${local.futures_mm_env_suffix}"
  alarm_description   = "Market maker error rate elevated (>5 errors in 5 minutes)"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Error Rate Alarm"
    Capability = "Monitoring"
  })
}

# WARNING - On-chain execution failures
resource "aws_cloudwatch_metric_alarm" "futures_mm_multicall_fail" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-multicall-fail-${local.futures_mm_env_suffix}"
  alarm_description   = "Multicall batch failed - market maker on-chain execution issue (futures or perps)"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "MulticallFailed"
  namespace           = local.futures_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = []
  ok_actions          = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Multicall Failure Alarm"
    Capability = "Monitoring"
  })
}

# The dashboard widgets live in the vault dashboard (07_col_mar_vault_mon.tf).

# The only component market-maker alarm that notifies. Component alarms stay silent.
resource "aws_cloudwatch_composite_alarm" "futures_mm_unhealthy" {
  count             = var.futures_mm_service.create ? 1 : 0
  provider          = aws.use1
  alarm_name        = "${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  alarm_description = "Market maker is unhealthy (it quotes futures and perps)"

  alarm_rule = join(" OR ", [
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_halt[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_no_tick[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_tick_error[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_cancel_fail[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_error_rate[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_multicall_fail[0].alarm_name})",
  ])

  alarm_actions = [aws_sns_topic.futures_mm_alerts[0].arn]
  ok_actions    = [aws_sns_topic.futures_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar MM Unhealthy"
    Capability = "Monitoring"
  })
}
