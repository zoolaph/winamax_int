# Terraform + AWS: Common Resources for a Winamax-Scale Stack

## The resources you must know cold

At Winamax (700+ microservices, ECS, MSK, RDS), you will be writing and reviewing Terraform for these resource types constantly. Each section shows the real declaration pattern with the attributes that actually matter.

---

## VPC and networking

```hcl
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true   # required for ECS task DNS resolution
  enable_dns_support   = true

  tags = { Name = "winamax-prod" }
}

resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "winamax-prod-private-${count.index + 1}", Tier = "private" }
}

resource "aws_subnet" "public" {
  count                   = 3
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index + 3)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "winamax-prod-public-${count.index + 1}", Tier = "public" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_nat_gateway" "main" {
  count         = 3   # one per AZ for HA
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
}
```

**Key decisions to know:**
- Private subnets for ECS tasks and RDS — they should never have public IPs
- Public subnets for ALBs — internet-facing load balancers require public subnets
- One NAT gateway per AZ — if you have one and that AZ goes down, private tasks lose internet access
- `enable_dns_hostnames = true` — required for ECS tasks to resolve each other by DNS

---

## IAM: roles and policies

IAM is the most verbose resource in Terraform and the one with the most gotchas.

```hcl
# ECS Task Role — what the application inside the container can do
resource "aws_iam_role" "bet_validator_task" {
  name = "bet-validator-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "bet_validator_task" {
  role = aws_iam_role.bet_validator_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read from SQS
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = aws_sqs_queue.bet_events.arn
      },
      {
        # Write to Kafka via MSK — MSK uses IAM auth
        Effect   = "Allow"
        Action   = ["kafka-cluster:Connect", "kafka-cluster:WriteData", "kafka-cluster:ReadData"]
        Resource = "arn:aws:kafka:eu-west-3:*:cluster/winamax-prod/*"
      }
    ]
  })
}

# ECS Task Execution Role — what ECS itself needs (pull image, push logs, read secrets)
resource "aws_iam_role" "task_execution" {
  name = "ecs-task-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
```

**Task Role vs Task Execution Role — the most common ECS Terraform mistake:**

| Role | Used by | Purpose |
|------|---------|---------|
| Task Role | The application container | Call AWS APIs from your app code |
| Task Execution Role | ECS daemon | Pull image from ECR, write logs to CloudWatch, read secrets |

They are different roles with different trust policies. Beginners often put everything in one role.

---

## ECS cluster and service

```hcl
resource "aws_ecs_cluster" "main" {
  name = "winamax-prod"

  setting {
    name  = "containerInsights"
    value = "enabled"   # enables Container Insights metrics in CloudWatch
  }
}

resource "aws_ecs_task_definition" "bet_validator" {
  family                   = "bet-validator"
  network_mode             = "awsvpc"          # required for Fargate
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.bet_validator_task.arn

  container_definitions = jsonencode([{
    name      = "bet-validator"
    image     = "${aws_ecr_repository.bet_validator.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = 8080
      protocol      = "tcp"
    }]

    environment = [
      { name = "ENV", value = var.environment },
      { name = "KAFKA_BROKERS", value = aws_msk_cluster.main.bootstrap_brokers_sasl_iam }
    ]

    secrets = [
      { name = "DB_PASSWORD", valueFrom = aws_secretsmanager_secret.db_password.arn }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/bet-validator"
        "awslogs-region"        = "eu-west-3"
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "bet_validator" {
  name            = "bet-validator"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.bet_validator.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.bet_validator.id]
    assign_public_ip = false  # private subnets, no public IP
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.bet_validator.arn
    container_name   = "bet-validator"
    container_port   = 8080
  }

  lifecycle {
    ignore_changes = [
      desired_count,    # managed by autoscaling
      task_definition,  # managed by deployment pipeline (not Terraform)
    ]
  }

  depends_on = [aws_lb_listener_rule.bet_validator]
}
```

---

## Application Load Balancer

```hcl
resource "aws_lb" "main" {
  name               = "winamax-prod-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = true   # prevent accidental destroy
}

resource "aws_lb_target_group" "bet_validator" {
  name        = "bet-validator"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"   # required for Fargate (awsvpc mode)

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.main.arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "bet_validator" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.bet_validator.arn
  }

  condition {
    path_pattern {
      values = ["/api/bets/*"]
    }
  }
}
```

---

## RDS (with Terraform safety)

```hcl
resource "aws_db_subnet_group" "main" {
  name       = "winamax-prod-rds"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier        = "winamax-prod-postgres"
  engine            = "postgres"
  engine_version    = "15.4"
  instance_class    = "db.r6g.2xlarge"   # 8 vCPU, 64 GB — sized for 50TB data
  allocated_storage = 500
  storage_type      = "gp3"
  storage_encrypted = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  multi_az               = true      # HA standby in another AZ
  backup_retention_period = 7        # 7 days of automated backups

  username = "postgres"
  password = random_password.db.result   # generated, stored in Secrets Manager

  deletion_protection = true         # block terraform destroy

  lifecycle {
    prevent_destroy = true           # belt and suspenders
    ignore_changes  = [engine_version]  # AWS manages minor version upgrades
  }
}
```

**The `prevent_destroy` + `deletion_protection` double lock:**
- `deletion_protection = true`: AWS refuses to delete the RDS instance via API
- `lifecycle { prevent_destroy = true }`: Terraform refuses to generate a plan that would destroy it

With 50 TB of data, both should be set.

---

## MSK (Kafka)

```hcl
resource "aws_msk_cluster" "main" {
  cluster_name           = "winamax-prod"
  kafka_version          = "3.5.1"
  number_of_broker_nodes = 6   # 2 per AZ across 3 AZs for HA

  broker_node_group_info {
    instance_type   = "kafka.m5.4xlarge"   # 16 vCPU, 64 GB — sized for 75k msg/sec
    client_subnets  = aws_subnet.private[*].id
    storage_info {
      ebs_storage_info {
        volume_size = 1000   # GB per broker
      }
    }
    security_groups = [aws_security_group.msk.id]
  }

  client_authentication {
    sasl {
      iam = true   # IAM-based auth — no separate credentials needed
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"   # encrypt client-to-broker traffic
      in_cluster    = true
    }
  }

  open_monitoring {
    prometheus {
      jmx_exporter  { enabled_in_broker = true }
      node_exporter { enabled_in_broker = true }
    }
  }
}
```

---

## Security groups pattern

```hcl
# ALB security group — accepts traffic from internet on 443
resource "aws_security_group" "alb" {
  name   = "winamax-prod-alb"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Service security group — accepts traffic only from ALB
resource "aws_security_group" "bet_validator" {
  name   = "winamax-prod-bet-validator"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]   # only from ALB, not internet
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

Prefer `security_groups` over `cidr_blocks` for service-to-service traffic — it follows the resource, not an IP range that can change.
