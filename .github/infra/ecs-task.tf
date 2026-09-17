# Reference Terraform for one MM ECS service.
#
# Copy this file into the consuming monorepo's terragrunt folder
# (perps/.bedrock/.terragrunt/ or futures-marketplace/.bedrock/.terragrunt/)
# and parameterise per venue:
#
#   - var.maker_app                "perps" | "futures"
#   - var.maker_env                 "dev" | "stg" | "prd" — picks configs/<app>.<env>.yml
#   - var.image_tag                 git-sha pinned image tag
#   - var.contract_address          PERPS_ADDRESS or FUTURES_ADDRESS
#   - var.eth_price_feed_address    optional Chainlink ETH/USD feed
#   - var.alchemy_api_key_secret_arn  AWS Secrets Manager ARN with the Alchemy API key
#   - var.private_key_secret_arn    AWS Secrets Manager ARN with the wallet PK
#
# The bundled YAMLs interpolate the RPC URL from ALCHEMY_API_KEY, so we
# inject that via Secrets Manager rather than passing the full URL.
#
# The task def expects the image at:
#   ghcr.io/lumerin-protocol/titan-market-maker:${var.image_tag}
#
# Inside the container:
#   - MAKER_APP    selects the entrypoint script in /app/docker-entrypoint.sh
#   - MAKER_CONFIG points at /app/configs/${MAKER_APP}.yml (default).
#   - All ${VAR} tokens in the YAML are expanded from this env block at boot.

resource "aws_cloudwatch_log_group" "market_maker" {
  name              = "/ecs/market-maker-${var.maker_app}-${var.account_shortname}"
  retention_in_days = 7

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Market Maker (${var.maker_app}) Logs"
    Capability = null
  })
}

resource "aws_iam_role" "market_maker_task_exec" {
  name = "market-maker-${var.maker_app}-task-exec-${var.account_shortname}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "market_maker_task_exec_basic" {
  role       = aws_iam_role.market_maker_task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "market_maker_secrets_access" {
  name = "market-maker-${var.maker_app}-secrets"
  role = aws_iam_role.market_maker_task_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [
        var.private_key_secret_arn,
        var.alchemy_api_key_secret_arn,
      ]
    }]
  })
}

resource "aws_ecs_task_definition" "market_maker" {
  family                   = "market-maker-${var.maker_app}-${var.account_shortname}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.market_maker_task_exec.arn
  # task_role_arn intentionally omitted: the container itself doesn't
  # need AWS API access. Secrets are injected by ECS via execution role.

  container_definitions = jsonencode([{
    name      = "market-maker"
    image     = "ghcr.io/lumerin-protocol/titan-market-maker:${var.image_tag}"
    essential = true

    environment = [
      { name = "MAKER_APP", value = var.maker_app },
      { name = "MAKER_ENV", value = var.maker_env },
      { name = "MAKER_CONFIG", value = "/app/configs/${var.maker_app}.${var.maker_env}.yml" },
      { name = "NODE_ENV", value = "production" },
      { name = "MAKER_LOG_LEVEL", value = "info" },
      { name = "ETH_PRICE_FEED_ADDRESS", value = var.eth_price_feed_address },
      { name = var.maker_app == "perps" ? "PERPS_ADDRESS" : "FUTURES_ADDRESS", value = var.contract_address },
    ]

    secrets = [
      { name = "PRIVATE_KEY", valueFrom = var.private_key_secret_arn },
      { name = "ALCHEMY_API_KEY", valueFrom = var.alchemy_api_key_secret_arn },
    ]

    portMappings = [{
      containerPort = 3001
      protocol      = "tcp"
    }]

    healthCheck = {
      command     = ["CMD-SHELL", "wget --quiet --tries=1 --spider http://localhost:3001/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.market_maker.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "market-maker"
      }
    }
  }])

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Market Maker (${var.maker_app})"
    Capability = null
  })
}

resource "aws_ecs_service" "market_maker" {
  name                   = "market-maker-${var.maker_app}-${var.account_shortname}"
  cluster                = var.ecs_cluster_arn
  task_definition        = aws_ecs_task_definition.market_maker.arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = true # for `aws ecs execute-command` debugging

  # Run-once-at-a-time semantics: only one MM per venue.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [var.security_group_id]
    assign_public_ip = false
  }

  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "Market Maker (${var.maker_app})"
    Capability = null
  })
}
