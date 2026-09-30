################################################################################
# FUTURES MARKET MAKER - ECS SERVICE
################################################################################
# CI (deploy-col-mar-mm.yml) rolls the image and the public env between
# applies, and both lifecycle blocks below keep a routine plan from fighting
# that. CPU and memory force a new revision, which does not honor
# ignore_changes, so that revision is built here from the same inputs CI uses:
#   image       ghcr tag from GitHub, or the running task if that is newer
#   environment non-empty keys in config/<env>.env (var.public_env)
#   secrets     PRIVATE_KEY and ALCHEMY_API_KEY valueFrom refs
# COMMIT_HASH is the commit the resolved image tag points at.
################################################################################

locals {
  futures_mm_env_suffix = substr(var.account_shortname, 8, 3)

  # Same denylist as deploy-col-mar-mm.yml. These are Secrets Manager
  # values, not config/<env>.env entries.
  futures_mm_secret_env_names = toset([
    "ALCHEMY_API_KEY",
    "LIQUIDATOR_PRIVATE_KEY",
    "WEBHOOK_SECRET",
    "PRIVATE_KEY",
    "FUTURES_MM_PRIVATE_KEY",
    "PERPS_MM_PRIVATE_KEY",
  ])

  futures_mm_file_env = {
    for key, value in var.public_env : key => value
    if trimspace(value) != ""
    && !contains(local.futures_mm_secret_env_names, key)
    && !contains(["MAKER_APP", "MAKER_ENV", "IMAGE_TAG", "COMMIT_HASH"], key)
  }

  # MAKER_APP and MAKER_ENV are required by docker-entrypoint.sh and are not
  # in the env file. IMAGE_TAG and COMMIT_HASH come from the resolved tag.
  futures_mm_environment = concat(
    [for key in sort(keys(local.futures_mm_file_env)) : {
      name  = key
      value = local.futures_mm_file_env[key]
    }],
    [
      { name = "COMMIT_HASH", value = local.futures_mm_commit_hash },
      { name = "IMAGE_TAG", value = local.futures_mm_image_tag },
      { name = "MAKER_APP", value = "portfolio" },
      { name = "MAKER_ENV", value = local.maker_env },
    ],
  )
}

################################
# SECURITY GROUPS
################################

resource "aws_security_group" "futures_mm_alb_use1" {
  count       = var.futures_mm_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-futures-mm-alb-${local.futures_mm_env_suffix}"
  description = "Security group for Futures Market Maker internal ALB"
  vpc_id      = data.aws_vpc.use1_1.id

  ingress {
    description = "HTTPS from VPC and VPN"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.use1_1.cidr_block, "172.18.0.0/19"]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM ALB Security Group",
      Capability = null,
    },
  )
}

resource "aws_security_group" "futures_mm_ecs_use1" {
  count       = var.futures_mm_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-futures-mm-ecs-${local.futures_mm_env_suffix}"
  description = "Security group for Futures Market Maker ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  ingress {
    description     = "HTTP from ALB"
    from_port       = var.futures_mm_service.cnt_port
    to_port         = var.futures_mm_service.cnt_port
    protocol        = "tcp"
    security_groups = [aws_security_group.futures_mm_alb_use1[count.index].id]
  }

  egress {
    description = "Allow all outbound (RPC + chain access)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM ECS Security Group",
      Capability = null,
    },
  )
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "futures_mm_use1" {
  count             = var.futures_mm_service.create ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  retention_in_days = 7

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM ECS Log Group",
      Capability = null,
    },
  )
}

################################
# APPLICATION LOAD BALANCER (INTERNAL)
################################

resource "aws_alb" "futures_mm_int_use1" {
  count                      = var.futures_mm_service.create ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.futures_mm_alb_use1[count.index].id]
  subnets                    = [for m in data.aws_subnet.middle_use1_1 : m.id]
  enable_deletion_protection = false

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM Internal ALB",
      Capability = null,
    },
  )
}

resource "aws_alb_target_group" "futures_mm_int_use1" {
  count                         = var.futures_mm_service.create ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  port                          = tonumber(var.futures_mm_service.cnt_port)
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled  = true
    interval = 30
    path     = "/health"
    port     = var.futures_mm_service.cnt_port
    protocol = "HTTP"
    # A tick on 0.25 vCPU can stall /health past 5s. Two misses 30s apart
    # was killing the task. 10s timeout and 4 misses is about two minutes.
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 4
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM Target Group",
      Capability = null,
    },
  )
}

resource "aws_alb_listener" "futures_mm_int_443_use1" {
  count             = var.futures_mm_service.create ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.futures_mm_int_use1[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn   = local.hp_acm["exc"].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.futures_mm_int_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM HTTPS Listener",
      Capability = null,
    },
  )
}

# Public alias in the Hashpower zone. Dev zones live in the workload account.
# LMN writes hashpower.exchange in titanio-net (aws.titanio-net).
resource "aws_route53_record" "futures_mm_int_use1" {
  count    = var.futures_mm_service.create && !local.is_lmn ? 1 : 0
  provider = aws.use1
  zone_id  = local.hp_dns["exc"].zone_id
  name     = "futuresmm.${local.hp_dns["exc"].name}"
  type     = "A"

  alias {
    name                   = aws_alb.futures_mm_int_use1[0].dns_name
    zone_id                = aws_alb.futures_mm_int_use1[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "futures_mm_int_lmn" {
  count    = var.futures_mm_service.create && local.is_lmn ? 1 : 0
  provider = aws.titanio-net
  zone_id  = local.hp_dns["exc"].zone_id
  name     = "futuresmm.${local.hp_dns["exc"].name}"
  type     = "A"

  alias {
    name                   = aws_alb.futures_mm_int_use1[0].dns_name
    zone_id                = aws_alb.futures_mm_int_use1[0].zone_id
    evaluate_target_health = true
  }
}

################################
# ECS SERVICE & TASK
################################

resource "aws_ecs_service" "futures_mm_use1" {
  # task_definition stays ignored so the next plan does not revert a CI roll.
  # A CPU or memory apply registers a new revision and does not point the
  # service at it while this ignore is set. Take task_definition out of the
  # list for that apply, then put it back.

  lifecycle { ignore_changes = [task_definition, desired_count] }
  count                  = var.futures_mm_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  cluster                = data.aws_ecs_cluster.derivatives.arn
  task_definition        = aws_ecs_task_definition.futures_mm_use1[count.index].arn
  # 0 here scales the maker down whenever the desired_count ignore is
  # commented out. task_worker_qty is the count this switch should push.
  desired_count          = var.futures_mm_service.task_worker_qty
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  # Ignore ALB target health for the first 5 minutes of a task. Measured on
  # LMN 2026-09-22: /health listens ~4 s after container start and portfolio
  # init finishes in 21-44 s, but the scheduler still killed nine v1.5.0
  # tasks in a row for "failed ELB health checks" (TG 30 s x 2, grace 0);
  # each replacement then raced the dying one on nonces. 300 s covers init
  # plus a slow RPC with room to spare and still replaces a task that never
  # comes up within ~6 minutes.
  health_check_grace_period_seconds = 300

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.futures_mm_ecs_use1[count.index].id]
  }

  load_balancer {
    target_group_arn = aws_alb_target_group.futures_mm_int_use1[count.index].arn
    container_name   = "${local.shortname}-futures-mm-container"
    container_port   = var.futures_mm_service.cnt_port
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM Service",
      Capability = null,
    },
  )
}

resource "aws_ecs_task_definition" "futures_mm_use1" {
  lifecycle { ignore_changes = [container_definitions] }
  count                    = var.futures_mm_service.create ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${local.shortname}-futures-mm"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.futures_mm_service.task_cpu
  memory                   = var.futures_mm_service.task_ram
  task_role_arn            = local.titanio_role_arn
  execution_role_arn       = local.titanio_role_arn

  # Used when this resource is created or replaced. In-place container drift
  # is ignored so CI can keep rolling the image and env.
  container_definitions = jsonencode([
    {
      name      = "${local.shortname}-futures-mm-container"
      image     = "${local.futures_mm_ghcr_repo}:${local.futures_mm_image_tag}"
      cpu       = 0
      essential = true

      portMappings = [
        {
          containerPort = tonumber(var.futures_mm_service.cnt_port)
          hostPort      = tonumber(var.futures_mm_service.cnt_port)
          protocol      = "tcp"
        }
      ]

      environment = local.futures_mm_environment

      secrets = [
        {
          name      = "PRIVATE_KEY"
          valueFrom = "${aws_secretsmanager_secret.futures_mm[0].arn}:private_key::"
        },
        {
          name      = "ALCHEMY_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.futures_mm[0].arn}:alchemy_api_key::"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = aws_cloudwatch_log_group.futures_mm_use1[0].name
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "${local.shortname}-futures-mm-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Futures MM ECS Task Definition",
      Capability = null,
    },
  )
}

################################
# ACCESS INFORMATION
################################
# Endpoint:
#   DEV: https://futuresmm.dev.hashpower.exchange/health
#   STG: https://futuresmm.stg.hashpower.exchange/health
#   LMN: https://futuresmm.hashpower.exchange/health
#
# Access restricted by ALB security group to:
#   - VPC CIDR: data.aws_vpc.use1_1.cidr_block
#   - VPN CIDR: 172.18.0.0/19
#
# Architecture:
#   futuresmm.{env}.hashpower.exchange (Route53 A record)
#     -> Internal ALB (HTTPS:443)
#       -> Target Group (health check: /health)
#         -> ECS Task (HTTP:cnt_port)
