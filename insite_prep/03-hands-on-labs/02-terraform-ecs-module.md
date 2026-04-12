# Hands-On Lab 02 — Write a Terraform ECS Service Module from Scratch

## Goal

Write a reusable Terraform module for an ECS Fargate service — from a blank file. No copy-paste from the internet. This is the skill they test on-site when they hand you a laptop.

**Time required:** 1.5–2 hours  
**What you build:** A module that creates an ECS service with its IAM roles, CloudWatch log group, and security group — all the resources a service needs to run.

---

## Rules for this exercise

1. Write the module without looking at existing Terraform code
2. Use `terraform validate` to check syntax errors — that is allowed
3. Do NOT use `terraform apply` until the plan is clean
4. After completing the module, apply it, verify the service is healthy, then destroy it

---

## Part 1: Module structure

Create this directory structure:

```
terraform-lab/
├── modules/
│   └── ecs-service/
│       ├── main.tf        ← resources
│       ├── variables.tf   ← inputs
│       └── outputs.tf     ← outputs
└── main.tf                ← root module that calls ecs-service
└── variables.tf           ← root variables
└── terraform.tfvars       ← your values
```

---

## Part 2: Write the module — variables.tf

The module needs these inputs. Write the variable blocks:

```
service_name        string   — name of the ECS service (e.g. "bet-validator")
cluster_arn         string   — ARN of the existing ECS cluster
image               string   — full ECR image URI including tag
container_port      number   — port the container listens on (default 3000)
cpu                 number   — task CPU units (default 256)
memory              number   — task memory in MB (default 512)
desired_count       number   — number of tasks (default 1)
subnet_ids          list     — subnet IDs to place tasks in
vpc_id              string   — VPC ID for security group
environment         map      — key/value environment variables (default empty)
```

Write these without looking at reference. Then check:

```bash
cd terraform-lab/modules/ecs-service
terraform validate
```

---

## Part 3: Write the module — main.tf

Write resources in this order. Each resource depends on the previous.

**Resource 1: CloudWatch log group**
- Name: `/ecs/${var.service_name}`
- Retention: 14 days

**Resource 2: IAM execution role**
- Trust policy: `ecs-tasks.amazonaws.com` can assume it
- Attach AWS managed policy `AmazonECSTaskExecutionRolePolicy`
- Name: `${var.service_name}-execution-role`

**Resource 3: IAM task role**
- Trust policy: `ecs-tasks.amazonaws.com` can assume it
- No policies attached (application grants added separately)
- Name: `${var.service_name}-task-role`

**Resource 4: Security group**
- Allow inbound TCP on `var.container_port` from anywhere (0.0.0.0/0 for this lab)
- Allow all outbound
- Name: `${var.service_name}-sg`
- VPC: `var.vpc_id`

**Resource 5: ECS task definition**
- Family: `var.service_name`
- Network mode: `awsvpc`
- Requires compatibility: `FARGATE`
- CPU: `var.cpu`
- Memory: `var.memory`
- Execution role ARN: the role you created above
- Task role ARN: the task role you created above
- Container definitions (JSON): name, image, port mapping, log configuration, environment variables

**Resource 6: ECS service**
- Cluster: `var.cluster_arn`
- Service name: `var.service_name`
- Task definition: the task definition above
- Desired count: `var.desired_count`
- Launch type: FARGATE
- Network configuration: `var.subnet_ids`, the security group above, `assignPublicIp=ENABLED`
- Deployment circuit breaker: enable with rollback

---

## Part 4: Write outputs.tf

Export:
- `service_name` — the ECS service name
- `task_definition_arn` — the task definition ARN
- `security_group_id` — the security group ID
- `execution_role_arn` — the execution role ARN

---

## Part 5: Write the root module

In `terraform-lab/main.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-3"
}

# Data sources to find existing infrastructure
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Create ECS cluster for the lab
resource "aws_ecs_cluster" "lab" {
  name = "terraform-lab-cluster"
}

# Call your module
module "ecs_lab_service" {
  source = "./modules/ecs-service"

  service_name  = var.service_name
  cluster_arn   = aws_ecs_cluster.lab.arn
  image         = var.image
  container_port = 3000
  desired_count = 1
  subnet_ids    = data.aws_subnets.default.ids
  vpc_id        = data.aws_vpc.default.id

  environment = {
    SERVICE_NAME = var.service_name
    PORT         = "3000"
  }
}

output "service_name" {
  value = module.ecs_lab_service.service_name
}
```

In `terraform-lab/variables.tf`:
```hcl
variable "service_name" {
  type    = string
  default = "tf-lab-service"
}

variable "image" {
  type = string
  # Set this in terraform.tfvars to your ECR image URI
}
```

In `terraform-lab/terraform.tfvars`:
```hcl
service_name = "tf-lab-service"
image        = "ACCOUNT.dkr.ecr.eu-west-3.amazonaws.com/ecs-lab:latest"
```

---

## Part 6: Apply and verify

```bash
cd terraform-lab
terraform init
terraform plan    # read every resource in the plan — understand what will be created
terraform apply

# After apply:
CLUSTER="terraform-lab-cluster"
SERVICE="tf-lab-service"

# Verify service is stable
aws ecs wait services-stable --cluster $CLUSTER --services $SERVICE

# Get task IP and test
TASK=$(aws ecs list-tasks --cluster $CLUSTER --service-name $SERVICE \
  --query 'taskArns[0]' --output text)

ENI=$(aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)

IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

curl http://${IP}:3000/
```

---

## Part 7: Add a lifecycle block

After the service is running, add `ignore_changes = [desired_count]` to the ECS service resource in your module. Run `terraform plan` — what does it show? Run `terraform apply` — what happens?

This simulates adding autoscaling to a running service.

---

## Part 8: Destroy

```bash
terraform destroy
```

Verify in the AWS console that all resources are gone: ECS service, cluster, IAM roles, security group, log group.

---

## What you should be able to do after this lab

- Write a complete ECS task definition and service resource from memory
- Explain why the execution role and task role are separate
- Explain what `ignore_changes` does and when to use it
- Explain the deployment circuit breaker and what it prevents
- Know the difference between `container_port` in the task definition and the security group rule
