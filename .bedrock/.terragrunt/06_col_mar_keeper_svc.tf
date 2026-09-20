################################################################################
# UNIFIED MARGIN KEEPER - ECS SERVICE (SCAFFOLDING)
################################################################################
# Replaces derivatives-marketplace perps-keeper (svc-perps-keeper-*).
# One long-running task liquidates across vault, PME, perps, and futures.
#
# deploy-keeper.yml owns image, env vars, secrets, and desired_count after
# the first CI/CD deploy. Terraform ships ALB + Route53 at keeper.{env}.*
# (same hostname as the legacy perps keeper once that stack is destroyed).
################################################################################

locals {
  keeper_env_suffix = substr(var.account_shortname, 8, 3)
}

################################
# SECURITY GROUPS
################################

resource "aws_security_group" "keeper_alb_use1" {
  count       = var.keeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-keeper-alb-${local.keeper_env_suffix}"
  description = "Security group for Col-Mar Keeper internal ALB"
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
      Name       = "Col-Mar Keeper ALB Security Group",
      Capability = null,
    },
  )
}

resource "aws_security_group" "keeper_ecs_use1" {
  count       = var.keeper_service.create ? 1 : 0
  provider    = aws.use1
  name        = "${local.shortname}-keeper-ecs-${local.keeper_env_suffix}"
  description = "Security group for Col-Mar Keeper ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  ingress {
    description     = "HTTP from ALB"
    from_port       = var.keeper_service.cnt_port
    to_port         = var.keeper_service.cnt_port
    protocol        = "tcp"
    security_groups = [aws_security_group.keeper_alb_use1[count.index].id]
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
      Name       = "Col-Mar Keeper ECS Security Group",
      Capability = null,
    },
  )
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "keeper_use1" {
  count             = var.keeper_service.create ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${local.shortname}-keeper-${local.keeper_env_suffix}"
  retention_in_days = 7

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper ECS Log Group",
      Capability = null,
    },
  )
}

################################
# APPLICATION LOAD BALANCER (INTERNAL)
################################

resource "aws_alb" "keeper_int_use1" {
  count                      = var.keeper_service.create ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-${local.shortname}-keeper-${local.keeper_env_suffix}"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.keeper_alb_use1[count.index].id]
  subnets                    = [for m in data.aws_subnet.middle_use1_1 : m.id]
  enable_deletion_protection = false

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper Internal ALB",
      Capability = null,
    },
  )
}

resource "aws_alb_target_group" "keeper_int_use1" {
  count                         = var.keeper_service.create ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.shortname}-keeper-${local.keeper_env_suffix}"
  port                          = tonumber(var.keeper_service.cnt_port)
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/health"
    port                = var.keeper_service.cnt_port
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper Target Group",
      Capability = null,
    },
  )
}

resource "aws_alb_listener" "keeper_int_443_use1" {
  count             = var.keeper_service.create ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.keeper_int_use1[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn   = local.hp_acm["exc"].arn

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.keeper_int_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper HTTPS Listener",
      Capability = null,
    },
  )
}

resource "aws_route53_record" "keeper_int_use1" {
  count    = var.keeper_service.create ? 1 : 0
  provider = aws.use1
  zone_id  = local.hp_dns["exc"].zone_id
  name     = "keeper.${local.hp_dns["exc"].name}"
  type     = "A"

  alias {
    name                   = aws_alb.keeper_int_use1[count.index].dns_name
    zone_id                = aws_alb.keeper_int_use1[count.index].zone_id
    evaluate_target_health = true
  }
}

################################
# ECS SERVICE & TASK
################################

resource "aws_ecs_service" "keeper_use1" {
  lifecycle { ignore_changes = [task_definition, desired_count] }
  count                  = var.keeper_service.create ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${local.shortname}-keeper-${local.keeper_env_suffix}"
  cluster                = data.aws_ecs_cluster.derivatives.arn
  task_definition        = aws_ecs_task_definition.keeper_use1[count.index].arn
  desired_count          = 0
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # One liquidator at a time — recreate strategy avoids duplicate txs on deploy.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.keeper_ecs_use1[count.index].id]
  }

  load_balancer {
    target_group_arn = aws_alb_target_group.keeper_int_use1[count.index].arn
    container_name   = "${local.shortname}-keeper-container"
    container_port   = var.keeper_service.cnt_port
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper Service",
      Capability = null,
    },
  )
}

resource "aws_ecs_task_definition" "keeper_use1" {
  lifecycle { ignore_changes = [container_definitions] }
  count                    = var.keeper_service.create ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${local.shortname}-keeper"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.keeper_service.task_cpu
  memory                   = var.keeper_service.task_ram
  task_role_arn            = local.titanio_role_arn
  execution_role_arn       = local.titanio_role_arn

  container_definitions = jsonencode([
    {
      name      = "${local.shortname}-keeper-container"
      image     = "public.ecr.aws/docker/library/busybox:latest"
      command   = ["sh", "-c", "echo 'col-mar keeper stub - awaiting CI/CD deploy'; sleep infinity"]
      cpu       = 0
      essential = true

      portMappings = [
        {
          containerPort = tonumber(var.keeper_service.cnt_port)
          hostPort      = tonumber(var.keeper_service.cnt_port)
          protocol      = "tcp"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = aws_cloudwatch_log_group.keeper_use1[0].name
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "${local.shortname}-keeper-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Col-Mar Keeper ECS Task Definition",
      Capability = null,
    },
  )
}

################################
# ACCESS INFORMATION
################################
#   DEV: https://keeper.dev.hashpower.exchange/health
#   STG: https://keeper.stg.hashpower.exchange/health
#   LMN: https://keeper.hashpower.exchange/health
#
# Legacy derivatives perps-keeper must be destroyed first (perpskeeper_service.create=false)
# so this stack can claim the keeper.* Route53 record.
