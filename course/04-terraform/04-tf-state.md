# Terraform State: Remote State, Locking, Workspaces vs Separate Roots

## What state is and why it matters

Terraform's state file (`terraform.tfstate`) is a JSON record of every resource Terraform manages — its real-world ID, all attributes, and dependencies. Without state, Terraform cannot:
- Know which real resource corresponds to which `.tf` declaration
- Detect drift (state = what Terraform thinks exists; reality = what the AWS API says)
- Understand dependencies for ordering

**The state file is not just metadata — it often contains sensitive values** (database passwords, API keys written to outputs, private keys). Never commit it to git. Never store it locally in a shared environment.

---

## Remote state: S3 + DynamoDB

The standard AWS pattern:

```hcl
terraform {
  backend "s3" {
    bucket         = "winamax-terraform-state"
    key            = "prod/ecs-cluster/terraform.tfstate"
    region         = "eu-west-3"
    encrypt        = true                        # SSE-S3 at rest
    dynamodb_table = "winamax-terraform-locks"   # for state locking
  }
}
```

### Why each component

**S3 bucket:**
- Central storage — the same state file is used by every engineer and CI job
- Enable versioning — you can roll back to a previous state if a bad apply corrupts it
- Enable server-side encryption — state may contain secrets
- Block public access — this is not a public bucket

**DynamoDB table:**
- Provides a distributed lock on the state file
- When `terraform apply` starts: it writes a lock entry to DynamoDB
- If another apply is running: the second one fails immediately with a lock error
- After apply completes: lock entry deleted

Without locking: two engineers run `terraform apply` simultaneously, both read the same state, both compute a plan, both start making changes, both write their resulting state — one overwrites the other. Resources are orphaned, state is corrupted.

### Setting up the S3 backend (bootstrap problem)

The S3 bucket and DynamoDB table cannot be managed by the same Terraform that uses them as a backend — circular dependency. Solutions:
1. Create them manually via console (one-time operation, acceptable for bootstrap)
2. Create them in a separate Terraform root with a local backend, then migrate
3. Use a shell script for initial creation (also acceptable for one-time bootstrap)

```bash
# Bootstrap: create the state bucket and lock table
aws s3api create-bucket \
  --bucket winamax-terraform-state \
  --region eu-west-3 \
  --create-bucket-configuration LocationConstraint=eu-west-3

aws s3api put-bucket-versioning \
  --bucket winamax-terraform-state \
  --versioning-configuration Status=Enabled

aws dynamodb create-table \
  --table-name winamax-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region eu-west-3
```

---

## State key structure — how to organize state files

Each independent unit of infrastructure should have its own state file. A good structure:

```
s3://winamax-terraform-state/
├── global/
│   ├── iam/terraform.tfstate          # cross-environment IAM roles
│   └── ecr/terraform.tfstate          # ECR registries (shared)
├── prod/
│   ├── vpc/terraform.tfstate           # VPC and networking
│   ├── ecs-cluster/terraform.tfstate   # ECS cluster
│   ├── rds/terraform.tfstate           # databases
│   ├── msk/terraform.tfstate           # Kafka
│   └── services/
│       ├── bet-validator/terraform.tfstate
│       └── odds-feed/terraform.tfstate
├── staging/
│   └── ...
└── dev/
    └── ...
```

Each state file = one Terraform root = one `terraform apply` blast radius.

**Why not one giant state?**
- A plan/apply in one giant root blocks all other changes (state lock)
- An error destroys unrelated resources
- A plan output is thousands of lines — impossible to review

---

## Remote state data source

To read outputs from another Terraform root:

```hcl
# In services/bet-validator: read the VPC state
data "terraform_remote_state" "vpc" {
  backend = "s3"
  config = {
    bucket = "winamax-terraform-state"
    key    = "prod/vpc/terraform.tfstate"
    region = "eu-west-3"
  }
}

resource "aws_security_group" "bet_validator" {
  vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id
  ...
}
```

This creates a **dependency between roots**. The VPC root must be applied first, and its outputs must exist before the service root can be applied.

---

## Workspaces vs separate roots

This is a common interview topic. Know when each is appropriate.

### Workspaces

Terraform workspaces are separate state files within the same backend key prefix, created from the same `.tf` files:

```bash
terraform workspace new prod
terraform workspace new staging
terraform workspace new dev
terraform workspace list
terraform workspace select prod
```

Each workspace gets its own state: `s3://bucket/key/prod/terraform.tfstate`, `s3://bucket/key/staging/terraform.tfstate`, etc.

In code, you reference the workspace:

```hcl
locals {
  env = terraform.workspace  # "prod", "staging", or "dev"
}

resource "aws_ecs_cluster" "main" {
  name = "winamax-${local.env}"
}
```

**When workspaces work well:**
- Environments are structurally identical (same resources, different sizes)
- Small number of environments
- You want a single `.tf` codebase to manage all of them

**When workspaces fail:**
- Environments diverge significantly (prod has a CDN layer that dev doesn't have)
- You need different providers or backends per environment
- A mistake in workspace selection (`terraform workspace select prod` when you meant `staging`) applies prod changes

**The workspace footgun:**

```bash
terraform workspace select prod  # you think you're in staging
terraform apply                  # you just applied to production
```

There is no confirmation prompt that tells you which workspace you're in. Many teams have learned this the hard way.

### Separate roots (recommended for production)

Each environment has its own directory with its own `main.tf` and backend config:

```
infra/
├── prod/
│   ├── vpc/
│   ├── ecs-cluster/
│   └── services/
├── staging/
│   ├── vpc/
│   └── ecs-cluster/
└── dev/
    └── ...
```

Running `terraform apply` in `infra/prod/ecs-cluster/` cannot accidentally touch staging — there is no mechanism for it.

**Recommendation for Winamax scale:** Separate roots per environment. Workspaces are acceptable for ephemeral environments (feature branches, test environments) where you want to spin up identical copies quickly.

---

## State operations (use with care)

```bash
# List all resources in state
terraform state list

# Move a resource in state (rename or move to module)
terraform state mv aws_ecs_cluster.old_name aws_ecs_cluster.new_name

# Remove a resource from state without destroying it
# (you want to unmanage it, not delete it)
terraform state rm aws_ecs_cluster.legacy

# Import an existing resource into state
terraform import aws_ecs_cluster.main arn:aws:ecs:eu-west-3:123456789:cluster/winamax-prod

# Pull state to local file (for inspection or emergency)
terraform state pull > state-backup.json

# Push local state back (use only in emergency, locking bypassed)
terraform state push state-backup.json
```

`terraform state rm` is the escape hatch when you want to stop managing a resource without destroying it. Use case: you created a resource in Terraform, now a different team will manage it — remove it from state so Terraform stops tracking it, without touching the actual resource.
