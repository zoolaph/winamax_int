# Terraform Fundamentals: Providers, Resources, State, Plan/Apply

## The mental model

Terraform is a **desired-state engine**. You describe what you want to exist. Terraform figures out how to make it exist. It tracks what it created in a state file so it knows what to change or destroy later.

Three things make Terraform work:
1. **Providers** — plugins that know how to talk to an API (AWS, GCP, GitHub, etc.)
2. **Resources** — things you want to exist (an ECS cluster, a VPC, an IAM role)
3. **State** — Terraform's memory of what it has created

---

## Providers

A provider is a plugin that translates Terraform resource declarations into API calls.

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"   # allow 5.x, block 6.x — pin major versions
    }
  }
  required_version = ">= 1.6"
}

provider "aws" {
  region = "eu-west-3"  # Paris — where Winamax runs
}
```

`terraform init` downloads the provider plugin. The provider version is locked in `.terraform.lock.hcl` — commit this file so every engineer and CI job uses the same provider version.

**Why version pinning matters:** AWS provider 4.x → 5.x had breaking changes to how S3 buckets are declared. Without a version pin, `terraform init` on a new machine could pull 5.x, break the plan, and block the pipeline.

---

## Resources

A resource is one real-world thing that Terraform manages.

```hcl
resource "aws_ecs_cluster" "main" {
  name = "winamax-prod"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Environment = "prod"
    ManagedBy   = "terraform"
  }
}
```

Structure: `resource "<provider>_<type>" "<local_name>" { ... }`

The local name (`main`) is how you reference this resource elsewhere in your code:

```hcl
resource "aws_ecs_service" "bet_validator" {
  cluster = aws_ecs_cluster.main.id  # references the cluster above
  ...
}
```

This creates an **implicit dependency** — Terraform knows to create the cluster before the service.

---

## Data sources

Data sources read existing resources (created outside Terraform or in another state):

```hcl
# Read an existing VPC by tag instead of hardcoding its ID
data "aws_vpc" "main" {
  tags = {
    Name = "winamax-prod"
  }
}

resource "aws_security_group" "bet_validator" {
  vpc_id = data.aws_vpc.main.id
  ...
}
```

Use data sources for resources you do not own or manage in this Terraform root. Use resources for what you do own.

---

## Variables and outputs

```hcl
variable "environment" {
  type        = string
  description = "Deployment environment: dev, staging, prod"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod"
  }
}

variable "task_cpu" {
  type    = number
  default = 256
}

output "cluster_arn" {
  description = "ECS cluster ARN — consumed by services in other roots"
  value       = aws_ecs_cluster.main.arn
}
```

Outputs are how you pass values between Terraform roots (via remote state data source).

---

## The plan/apply lifecycle

```
                    ┌──────────────────┐
                    │   .tf files      │  ← what you want
                    │   (desired state)│
                    └────────┬─────────┘
                             │
                    terraform plan
                             │
                    ┌────────▼─────────┐
                    │   State file     │  ← what Terraform thinks exists
                    │   (current state)│
                    └────────┬─────────┘
                             │ diff
                    ┌────────▼─────────┐
                    │  Execution plan  │  ← what will change
                    │  + resource to   │
                    │  - resource from │
                    │  ~ resource in   │
                    └────────┬─────────┘
                             │ review ← DO NOT SKIP THIS
                    terraform apply
                             │
                    ┌────────▼─────────┐
                    │  AWS API calls   │  ← real changes
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  Updated state   │
                    └──────────────────┘
```

### Plan symbols

| Symbol | Meaning |
|--------|---------|
| `+` | will be created |
| `-` | will be destroyed |
| `~` | will be updated in-place |
| `-/+` | will be destroyed and recreated (replacement) |

**The `-/+` symbol is dangerous.** Some attribute changes force replacement rather than in-place update. For a database, replacement means: destroy the old RDS instance, create a new empty one. Data gone.

Always read replacement-flagged resources carefully. Add `lifecycle { prevent_destroy = true }` to databases and other stateful resources.

---

## Lifecycle rules

```hcl
resource "aws_db_instance" "main" {
  # ...
  lifecycle {
    prevent_destroy       = true   # block terraform destroy
    create_before_destroy = true   # create new before destroying old (for zero-downtime)
    ignore_changes        = [
      engine_version,              # AWS auto-upgrades; ignore drift on this field
    ]
  }
}
```

---

## Local values

```hcl
locals {
  common_tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Team        = "platform"
  }

  name_prefix = "winamax-${var.environment}"
}

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"
  tags = local.common_tags
}
```

Locals reduce repetition without creating an input variable that callers can override.

---

## Key commands

```bash
terraform init          # download providers, configure backend
terraform validate      # check syntax and internal consistency (no API calls)
terraform fmt           # auto-format .tf files (run in CI — fail if output differs)
terraform plan          # show what will change
terraform plan -out=tfplan  # save plan to file (ensures apply uses exact reviewed plan)
terraform apply tfplan  # apply the saved plan
terraform apply -auto-approve  # skip confirmation (CI only, never manually)
terraform destroy       # destroy all managed resources (dangerous)
terraform output        # show output values
terraform state list    # list all resources in state
terraform state show <resource>  # show current state of a resource
```

---

## Bridge from K8s

| Kubernetes | Terraform |
|-----------|-----------|
| `kubectl apply -f manifest.yaml` | `terraform apply` |
| `kubectl diff -f manifest.yaml` | `terraform plan` |
| etcd (K8s API stores state) | state file (Terraform manages its own state) |
| Helm chart values | Terraform variables |
| Helm release | Terraform root module |
| namespace | workspace or separate root |

The key asymmetry: Kubernetes derives desired state from the API server directly. Terraform must maintain its own state file. This makes state management a first-class concern in Terraform that has no equivalent in K8s operations.
