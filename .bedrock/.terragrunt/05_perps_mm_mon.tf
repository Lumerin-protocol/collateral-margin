################################################################################
# PERPS MARKET MAKER — MONITORING
# Metric filters, alarms, and dashboard for the Perps Market Maker ECS service
#
# Log format: structured JSON via pino
#   level 30 = info, 40 = warn, 50 = error
#
# Key log messages:
#   "tick"                         heartbeat with balances/orders
#   "tick error"                   main loop iteration failed (level 50)
#   "HALT: *"                      risk manager stopped trading (level 50)
#   "multicall batch executed"     successful on-chain order batch
#   "multicall batch failed"       failed on-chain execution (level 50)
#   "cancel-all multicall failed"  can't cancel orders on-chain (level 50)
#   "own order matched"            one of our orders was filled
#   "throttled: *"                 gas budget exceeded (level 40)
#   "ETH price feed read failed"   oracle/gas pricing source broken (level 40)
#   "initialization failed, *"     service can't start (level 40)
#   "cancelling all orders"        emergency order pull (level 40)
################################################################################

locals {
  perps_mm_metric_ns = "ColMarPerpsMM"
}

################################################################################
# SNS TOPIC
#
# Dedicated topic for perps market maker alerts. Subscribe the devops-alerts
# Lambda (titanio-{env}-dev-alerts -> Slack) externally to route into Slack.
################################################################################

resource "aws_sns_topic" "perps_mm_alerts" {
  count    = var.perps_mm_service.create ? 1 : 0
  provider = aws.use1
  name     = "${local.shortname}-perps-mm-alerts-${local.perps_mm_env_suffix}"

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM Alerts"
    Capability = "Monitoring"
  })
}

################################################################################
# METRIC FILTERS - EVENT COUNTS
################################################################################

resource "aws_cloudwatch_log_metric_filter" "perps_mm_halt_count" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-halt-count"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"HALT:*\" }"

  metric_transformation {
    name      = "HaltCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_error_count" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-error-count"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.level = 50 }"

  metric_transformation {
    name      = "ErrorCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_warn_count" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-warn-count"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.level = 40 }"

  metric_transformation {
    name      = "WarnCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_tick_count" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-tick-count"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick\" }"

  metric_transformation {
    name      = "TickCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_tick_error" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-tick-error"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick error\" }"

  metric_transformation {
    name      = "TickErrorCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_gas_throttle" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-gas-throttle"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"throttled:*\" }"

  metric_transformation {
    name      = "GasThrottleCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_multicall_ok" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-multicall-ok"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"multicall batch executed\" }"

  metric_transformation {
    name      = "MulticallExecuted"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_multicall_fail" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-multicall-fail"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"multicall batch failed\" }"

  metric_transformation {
    name      = "MulticallFailed"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_cancel_all_fail" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-cancel-all-fail"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"cancel-all multicall failed\" }"

  metric_transformation {
    name      = "CancelAllFailed"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_order_matched" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-order-matched"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"own order matched\" }"

  metric_transformation {
    name      = "OrderMatched"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_price_feed_fail" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-price-feed-fail"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"ETH price feed read failed\" }"

  metric_transformation {
    name      = "PriceFeedFailed"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_init_retry" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-init-retry"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"initialization failed, retrying\" }"

  metric_transformation {
    name      = "InitRetryCount"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_cancel_all_triggered" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-cancel-all-triggered"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"cancelling all orders\" }"

  metric_transformation {
    name      = "CancelAllTriggered"
    namespace = local.perps_mm_metric_ns
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# METRIC FILTERS - VALUES EXTRACTED FROM TICK
################################################################################

resource "aws_cloudwatch_log_metric_filter" "perps_mm_collateral" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-collateral"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick\" }"

  metric_transformation {
    name          = "CollateralBalance"
    namespace     = local.perps_mm_metric_ns
    value         = "$.collateralBalance"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_eth_balance" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-eth-balance"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick\" }"

  metric_transformation {
    name          = "EthBalance"
    namespace     = local.perps_mm_metric_ns
    value         = "$.ethBalance"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_active_orders" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-active-orders"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick\" }"

  metric_transformation {
    name          = "ActiveOrders"
    namespace     = local.perps_mm_metric_ns
    value         = "$.orders"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "perps_mm_oracle_price" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  name           = "${local.shortname}-perps-mm-oracle-price"
  log_group_name = aws_cloudwatch_log_group.perps_mm_use1[0].name
  pattern        = "{ $.msg = \"tick\" }"

  metric_transformation {
    name          = "OraclePrice"
    namespace     = local.perps_mm_metric_ns
    value         = "$.oracle"
    default_value = "0"
  }
}

################################################################################
# ALARMS
################################################################################

# CRITICAL - Market maker halted (collateral or daily loss limit)
resource "aws_cloudwatch_metric_alarm" "perps_mm_halt" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-halt-${local.perps_mm_env_suffix}"
  alarm_description   = "Perps market maker emitted a HALT event - trading stopped"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HaltCount"
  namespace           = local.perps_mm_metric_ns
  period              = 60
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM HALT Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - No heartbeat for 5 minutes (service is down or stuck)
resource "aws_cloudwatch_metric_alarm" "perps_mm_no_tick" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-no-tick-${local.perps_mm_env_suffix}"
  alarm_description   = "No tick events for 5+ minutes - perps mm may be down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "TickCount"
  namespace           = local.perps_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM No Tick Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Main loop crashing repeatedly
resource "aws_cloudwatch_metric_alarm" "perps_mm_tick_error" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-tick-error-${local.perps_mm_env_suffix}"
  alarm_description   = "Tick errors repeating - perps main loop is failing"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "TickErrorCount"
  namespace           = local.perps_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 3
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM Tick Error Alarm"
    Capability = "Monitoring"
  })
}

# CRITICAL - Cannot cancel orders (exposed position)
resource "aws_cloudwatch_metric_alarm" "perps_mm_cancel_fail" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-cancel-fail-${local.perps_mm_env_suffix}"
  alarm_description   = "Cancel-all multicall failed - perps orders stuck on-chain"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "CancelAllFailed"
  namespace           = local.perps_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM Cancel Failure Alarm"
    Capability = "Monitoring"
  })
}

# WARNING - Elevated error rate
resource "aws_cloudwatch_metric_alarm" "perps_mm_error_rate" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-errors-${local.perps_mm_env_suffix}"
  alarm_description   = "Perps mm error rate elevated (>5 errors in 5 minutes)"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ErrorCount"
  namespace           = local.perps_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM Error Rate Alarm"
    Capability = "Monitoring"
  })
}

# WARNING - On-chain execution failures
resource "aws_cloudwatch_metric_alarm" "perps_mm_multicall_fail" {
  count               = var.perps_mm_service.create ? 1 : 0
  provider            = aws.use1
  alarm_name          = "${local.shortname}-perps-mm-multicall-fail-${local.perps_mm_env_suffix}"
  alarm_description   = "Multicall batch failed - perps on-chain execution issue"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "MulticallFailed"
  namespace           = local.perps_mm_metric_ns
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.perps_mm_alerts[0].arn]
  ok_actions          = [aws_sns_topic.perps_mm_alerts[0].arn]

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Col-Mar Perps MM Multicall Failure Alarm"
    Capability = "Monitoring"
  })
}

################################################################################
# DASHBOARD
################################################################################

resource "aws_cloudwatch_dashboard" "perps_mm" {
  count          = var.perps_mm_service.create ? 1 : 0
  provider       = aws.use1
  dashboard_name = "${local.shortname}-perps-mm-${local.perps_mm_env_suffix}"

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
            [local.perps_mm_metric_ns, "TickCount", { stat = "Sum", label = "Ticks" }]
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
            [local.perps_mm_metric_ns, "HaltCount", { stat = "Sum", label = "HALTs", color = "#d62728" }]
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
            [local.perps_mm_metric_ns, "ErrorCount", { stat = "Sum", label = "Errors", color = "#ff7f0e" }]
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
            [local.perps_mm_metric_ns, "TickErrorCount", { stat = "Sum", label = "Tick Errors", color = "#d62728" }]
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
            [local.perps_mm_metric_ns, "ActiveOrders", { stat = "Average", label = "Orders" }]
          ]
          view   = "singleValue"
          region = var.default_region
          period = 60
          title  = "Active Orders"
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
            [local.perps_mm_metric_ns, "CancelAllFailed", { stat = "Sum", label = "Cancel Fails", color = "#d62728" }]
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
            aws_cloudwatch_metric_alarm.perps_mm_halt[0].arn,
            aws_cloudwatch_metric_alarm.perps_mm_no_tick[0].arn,
            aws_cloudwatch_metric_alarm.perps_mm_tick_error[0].arn,
            aws_cloudwatch_metric_alarm.perps_mm_cancel_fail[0].arn,
            aws_cloudwatch_metric_alarm.perps_mm_error_rate[0].arn,
            aws_cloudwatch_metric_alarm.perps_mm_multicall_fail[0].arn,
          ]
          title = "Alarm Status"
        }
      },

      # Row 3: Balances & Oracle
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 8
        height = 6
        properties = {
          metrics = [
            [local.perps_mm_metric_ns, "CollateralBalance", { stat = "Average", label = "Collateral (raw)" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 60
          title  = "Collateral Balance"
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
            [{ expression = "m1/1000000000000000000", label = "ETH", id = "e1" }],
            [local.perps_mm_metric_ns, "EthBalance", { stat = "Average", id = "m1", visible = false }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 60
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
            [{ expression = "m1/100", label = "Oracle ($)", id = "e1" }],
            [local.perps_mm_metric_ns, "OraclePrice", { stat = "Average", id = "m1", visible = false }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 60
          title  = "Oracle Price (ETH/USD)"
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
            [local.perps_mm_metric_ns, "MulticallExecuted", { stat = "Sum", label = "Executed", color = "#2ca02c" }],
            [local.perps_mm_metric_ns, "MulticallFailed", { stat = "Sum", label = "Failed", color = "#d62728" }]
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
            [local.perps_mm_metric_ns, "OrderMatched", { stat = "Sum", label = "Fills", color = "#1f77b4" }]
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
            [local.perps_mm_metric_ns, "CancelAllTriggered", { stat = "Sum", label = "Cancel All", color = "#ff7f0e" }],
            [local.perps_mm_metric_ns, "CancelAllFailed", { stat = "Sum", label = "Cancel Failed", color = "#d62728" }]
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
            [local.perps_mm_metric_ns, "WarnCount", { stat = "Sum", label = "Warnings", color = "#ff7f0e" }],
            [local.perps_mm_metric_ns, "GasThrottleCount", { stat = "Sum", label = "Gas Throttle", color = "#9467bd" }]
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
            [local.perps_mm_metric_ns, "PriceFeedFailed", { stat = "Sum", label = "Price Feed Fail", color = "#d62728" }],
            [local.perps_mm_metric_ns, "InitRetryCount", { stat = "Sum", label = "Init Retries", color = "#ff7f0e" }]
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
            [local.perps_mm_metric_ns, "ActiveOrders", { stat = "Average", label = "Active Orders", color = "#1f77b4" }]
          ]
          view   = "timeSeries"
          region = var.default_region
          period = 60
          title  = "Active Orders Over Time"
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
          query  = "SOURCE '${aws_cloudwatch_log_group.perps_mm_use1[0].name}' | fields @timestamp, msg, component, coalesce(message, '') as detail | filter level >= 40 | sort @timestamp desc | limit 50"
          region = var.default_region
          title  = "Recent Errors & Warnings"
          view   = "table"
        }
      }
    ]
  })
}
