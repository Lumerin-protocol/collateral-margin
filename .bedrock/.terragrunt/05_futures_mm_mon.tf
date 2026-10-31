################################################################################
# FUTURES MARKET MAKER — MONITORING
# Metric filters, alarms, and dashboard for the Futures Market Maker ECS service
#
# Mirror of 05_perps_mm_mon.tf with venue-specific names and metric namespace.
# The portfolio runner logs "portfolio tick" once per successful loop.
# Component alarms do not notify. The composite does, plus the error and
# warning log alarms, which use the shared alert topics like the keeper.
################################################################################

locals {
  futures_mm_metric_ns = "ColMarFuturesMM"
}

################################################################################
# SNS — look up foundation-core HPDX topics (do not create orphan topics)
################################################################################

locals {
  futures_mm_alerts_topic_name = var.account_lifecycle == "prd" ? (
    var.vault_monitoring.devops_alerts_topic_name != "" ? var.vault_monitoring.devops_alerts_topic_name : "titanio-${local.futures_mm_env_suffix}-hpdx-page"
  ) : (
    var.vault_monitoring.dev_alerts_topic_name != "" ? var.vault_monitoring.dev_alerts_topic_name : "titanio-${local.futures_mm_env_suffix}-hpdx-alerts"
  )
}

data "aws_sns_topic" "futures_mm_alerts" {
  count    = var.futures_mm_service.create ? 1 : 0
  provider = aws.use1
  name     = local.futures_mm_alerts_topic_name
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
  alarm_description   = "Futures market maker emitted a HALT event - trading stopped"
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
    Name       = "Col-Mar Futures MM HALT Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - No heartbeat for 5 minutes (service is down or stuck)
resource "aws_cloudwatch_metric_alarm" "futures_mm_no_tick" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-no-tick-${local.futures_mm_env_suffix}"
  alarm_description   = "No portfolio tick logs for 5+ minutes - futures mm may be down"
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
    Name       = "Col-Mar Futures MM No Tick Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Main loop crashing repeatedly
resource "aws_cloudwatch_metric_alarm" "futures_mm_tick_error" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-tick-error-${local.futures_mm_env_suffix}"
  alarm_description   = "Tick errors repeating - futures main loop is failing"
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
    Name       = "Col-Mar Futures MM Tick Error Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Cannot cancel orders (exposed position)
resource "aws_cloudwatch_metric_alarm" "futures_mm_cancel_fail" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-cancel-fail-${local.futures_mm_env_suffix}"
  alarm_description   = "Cancel-all multicall failed - futures orders stuck on-chain"
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
    Name       = "Col-Mar Futures MM Cancel Failure Alarm"
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
  alarm_description   = "Futures market maker logged an error (pino level 50). Read its ECS logs; check quotes and inventory."
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
    Name       = "Col-Mar Futures MM Error Logged"
    Capability = "Monitoring"
  })
}

resource "aws_cloudwatch_metric_alarm" "futures_mm_warnings" {
  count               = var.vault_monitoring.create && var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-warnings-${local.futures_mm_env_suffix}"
  alarm_description   = "Futures market maker logged 20+ warnings (pino level 40) in 15 minutes, e.g. throttling, cancel-all or init retries. Read its ECS logs."
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
    Name       = "Col-Mar Futures MM Warnings"
    Capability = "Monitoring"
  })
}

# WARNING - Elevated error rate
resource "aws_cloudwatch_metric_alarm" "futures_mm_error_rate" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-errors-${local.futures_mm_env_suffix}"
  alarm_description   = "Futures mm error rate elevated (>5 errors in 5 minutes)"
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
    Name       = "Col-Mar Futures MM Error Rate Alarm"
    Capability = "Monitoring"
  })
}

# WARNING - On-chain execution failures
resource "aws_cloudwatch_metric_alarm" "futures_mm_multicall_fail" {
  count               = var.futures_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-futures-mm-multicall-fail-${local.futures_mm_env_suffix}"
  alarm_description   = "Multicall batch failed - futures on-chain execution issue"
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
    Name       = "Col-Mar Futures MM Multicall Failure Alarm"
    Capability = "Monitoring"
  })
}

################################################################################
# DASHBOARD
################################################################################

resource "aws_cloudwatch_dashboard" "futures_mm" {
  count          = var.futures_mm_service.create ? 1 : 0
  provider       = aws.use1
  dashboard_name = "${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"

  dashboard_body = jsonencode({
    widgets = [
      # Row 1: Health Overview (single-value)
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "TickCount", { stat = "Sum", label = "Ticks" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 60
          title  = "Ticks / min"
        }
      },
      {
        type   = "metric"
        x      = 4
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "HaltCount", { stat = "Sum", label = "HALTs", color = "#d62728" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "HALTs (5m)"
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "ErrorCount", { stat = "Sum", label = "Errors", color = "#ff7f0e" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "Errors (5m)"
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "TickErrorCount", { stat = "Sum", label = "Tick Errors", color = "#d62728" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "Tick Errors (5m)"
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.vault_mon_ns, "BookMinSideLevels", { stat = "Minimum", label = "Levels" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "Emptiest Book Side"
        }
      },
      {
        type   = "metric"
        x      = 20
        y      = 0
        width  = 4
        height = 4
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "CancelAllFailed", { stat = "Sum", label = "Cancel Fails", color = "#d62728" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 300
          title  = "Cancel Fails (5m)"
        }
      },

      # Row 2: Alarm Status
      {
        type   = "alarm"
        x      = 0
        y      = 4
        width  = 24
        height = 3
        properties = {
          alarms = [
            aws_cloudwatch_metric_alarm.futures_mm_halt[0].arn,
            aws_cloudwatch_metric_alarm.futures_mm_no_tick[0].arn,
            aws_cloudwatch_metric_alarm.futures_mm_tick_error[0].arn,
            aws_cloudwatch_metric_alarm.futures_mm_cancel_fail[0].arn,
            aws_cloudwatch_metric_alarm.futures_mm_error_rate[0].arn,
            aws_cloudwatch_metric_alarm.futures_mm_multicall_fail[0].arn,
          ]
          title = "Alarm Status"
        }
      },

      # Row 3: Balances & Positions
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.vault_mon_ns, "MmVaultBalance", { stat = "Average", label = "Vault balance" }],
            [local.vault_mon_ns, "MmPortfolioIM", { stat = "Average", label = "Portfolio IM" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Collateral (USDC)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.vault_mon_ns, "MmEthBalance", { stat = "Minimum", label = "ETH" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "ETH Balance"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"MmPositionNotional\"', 'Maximum', 300)", id = "pos", label = "" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Position Notional by Market (USDC)"
          yAxis  = { left = { min = 0 } }
        }
      },

      # Row 4: Trading Activity
      {
        type   = "metric"
        x      = 0
        y      = 13
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "MulticallExecuted", { stat = "Sum", label = "Executed", color = "#2ca02c" }],
            [local.futures_mm_metric_ns, "MulticallFailed", { stat = "Sum", label = "Failed", color = "#d62728" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Multicall Batches (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 13
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "OrderMatched", { stat = "Sum", label = "Fills", color = "#1f77b4" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Order Fills (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 13
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "CancelAllTriggered", { stat = "Sum", label = "Cancel All", color = "#ff7f0e" }],
            [local.futures_mm_metric_ns, "CancelAllFailed", { stat = "Sum", label = "Cancel Failed", color = "#d62728" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Cancel All Events (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },

      # Row 5: Infrastructure Health
      {
        type   = "metric"
        x      = 0
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "WarnCount", { stat = "Sum", label = "Warnings", color = "#ff7f0e" }],
            [local.futures_mm_metric_ns, "GasThrottleCount", { stat = "Sum", label = "Gas Throttle", color = "#9467bd" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Warnings & Gas Throttle (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.futures_mm_metric_ns, "PriceFeedFailed", { stat = "Sum", label = "Price Feed Fail", color = "#d62728" }],
            [local.futures_mm_metric_ns, "InitRetryCount", { stat = "Sum", label = "Init Retries", color = "#ff7f0e" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Price Feed & Init Failures (5m)"
          yAxis  = { left = { min = 0 } }
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 19
        width  = 8
        height = 6
        properties = {
          metrics = [
            [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookBidLevels\"', 'Minimum', 300)", id = "bids", label = "bids" }],
            [{ expression = "SEARCH('{${local.vault_mon_ns},Market} MetricName=\"BookAskLevels\"', 'Minimum', 300)", id = "asks", label = "asks" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 300
          title  = "Book Levels by Market"
          yAxis  = { left = { min = 0 } }
        }
      },

      # Row 6: Logs
      {
        type   = "log"
        x      = 0
        y      = 25
        width  = 24
        height = 6
        properties = {
          query  = "SOURCE '${aws_cloudwatch_log_group.futures_mm_use1[0].name}' | fields @timestamp, msg, component, coalesce(message, '') as detail | filter level >= 40 | sort @timestamp desc | limit 50"
          region = var.default_region
          title  = "Recent Errors & Warnings"
          view   = "table"
        }
      }
    ]
  })
}

# The only futures market-maker alarm that notifies. Component alarms stay silent.
resource "aws_cloudwatch_composite_alarm" "futures_mm_unhealthy" {
  count             = var.futures_mm_service.create ? 1 : 0
  provider          = aws.use1
  alarm_name        = "${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  alarm_description = "Futures market maker is unhealthy"

  alarm_rule = join(" OR ", [
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_halt[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_no_tick[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_tick_error[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_cancel_fail[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_error_rate[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.futures_mm_multicall_fail[0].alarm_name})",
  ])

  alarm_actions = [data.aws_sns_topic.futures_mm_alerts[0].arn]
  ok_actions    = [data.aws_sns_topic.futures_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Futures MM Unhealthy"
    Capability = "Monitoring"
  })
}
