################################################################################
# FUTURES MARKET MAKER - ECS SERVICE (SCAFFOLDING)
################################################################################
# Mirror of 04_perps_mm_svc.tf for MAKER_APP=futures. Same CI/CD-owned
# personality model: Terraform builds infra, deploy-col-mar-mm.yml owns
# image / env vars / secrets / desired_count after first apply.
#
# Replaces the legacy futures market-maker Lambda (futures-marketplace,
# 10_market_maker_lambda.tf). DNS name `futuresmm.{env}.hashpower.exchange`
# does not collide with anything currently in derivatives or futures repos,
# so this can be applied immediately.
################################################################################

locals {
  futures_mm_env_suffix = substr(var.account_shortname, 8, 3)
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
    enabled             = true
    interval            = 30
    path                = "/health"
    port                = var.futures_mm_service.cnt_port
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
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

resource "aws_route53_record" "futures_mm_int_use1" {
  count    = var.futures_mm_service.create ? 1 : 0
  provider = aws.use1
  zone_id  = local.hp_dns["exc"].zone_id
  name     = "futuresmm.${local.hp_dns["exc"].name}"
  type     = "A"

  alias {
    name                   = aws_alb.futures_mm_int_use1[count.index].dns_name
    zone_id                = aws_alb.futures_mm_int_use1[count.index].zone_id
    evaluate_target_health = true
  }
}

################################
# ECS SERVICE & TASK
################################

resource "aws_ecs_service" "futures_mm_use1" {
  lifecycle { ignore_changes = [task_definition, desired_count] }
  count                  = var.futures_mm_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${local.shortname}-futures-mm-${local.futures_mm_env_suffix}"
  cluster                = data.aws_ecs_cluster.derivatives.arn
  task_definition        = aws_ecs_task_definition.futures_mm_use1[count.index].arn
  desired_count          = 0
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

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

  # STUB CONTAINER. CI/CD overwrites this on every deploy; the only thing
  # that matters here is that the task def is registerable. See the perps
  # equivalent for full rationale.
  container_definitions = jsonencode([
    {
      name      = "${local.shortname}-futures-mm-container"
      image     = "public.ecr.aws/docker/library/busybox:latest"
      command   = ["sh", "-c", "echo 'col-mar futures-mm stub - awaiting CI/CD deploy'; sleep infinity"]
      cpu       = 0
      essential = true

      portMappings = [
        {
          containerPort = tonumber(var.futures_mm_service.cnt_port)
          hostPort      = tonumber(var.futures_mm_service.cnt_port)
          protocol      = "tcp"
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
