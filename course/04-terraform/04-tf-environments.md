# Environment Strategy: Safely Separating Dev, Staging, and Prod

## The core problem

At Winamax, a misconfigured staging deployment is an inconvenience. A misconfigured prod deployment at 75,000 msg/sec and 900,000 bets/day is a P1 incident with revenue impact. The environment strategy must make it structurally impossible to accidentally apply staging changes to production.

---

## Recommended structure: separate roots per environment

```
infra/
├── modules/                    # shared modules (no state here)
│   ├── ecs-service/
│   ├── ecs-cluster/
│   └── rds/
├── global/                     # resources shared across all environments
│   ├── ecr/                    # ECR registries (images are environment-agnostic)
│   │   ├── main.tf
│   │   └── backend.tf
│   └── iam-cross-account/      # cross-account roles if multi-account
├── prod/
│   ├── vpc/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── backend.tf          # points to prod/vpc/terraform.tfstate
│   ├── ecs-cluster/
│   ├── rds/
│   └── services/
│       ├── bet-validator/
│       └── odds-feed/
├── staging/
│   ├── vpc/
│   ├── ecs-cluster/
│   └── services/
└── dev/
    └── ...
```

To apply a change to prod, you must `cd infra/prod/services/bet-validator && terraform apply`. There is no command that can reach prod from the staging directory.

---

## Backend config per environment

Each environment root has its own `backend.tf`:

```hcl
# infra/prod/ecs-cluster/backend.tf
terraform {
  backend "s3" {
    bucket         = "winamax-terraform-state"
    key            = "prod/ecs-cluster/terraform.tfstate"
    region         = "eu-west-3"
    encrypt        = true
    dynamodb_table = "winamax-terraform-locks"
  }
}

# infra/staging/ecs-cluster/backend.tf
terraform {
  backend "s3" {
    bucket         = "winamax-terraform-state"
    key            = "staging/ecs-cluster/terraform.tfstate"  # different key
    region         = "eu-west-3"
    encrypt        = true
    dynamodb_table = "winamax-terraform-locks"
  }
}
```

Different state keys = different state files = separate blast radii.

---

## Passing environment-specific values

### Option A: tfvars files

```hcl
# variables.tf (in each root)
variable "desired_count" {
  type = number
}
variable "cpu" {
  type = number
}
variable "memory" {
  type = number
}
```

```hcl
# prod.tfvars
desired_count = 10
cpu           = 1024
memory        = 2048

# staging.tfvars
desired_count = 2
cpu           = 256
memory        = 512
```

```bash
terraform apply -var-file=prod.tfvars
```

In CI: the pipeline selects the tfvars file based on the branch or environment context.

### Option B: Environment-specific variable files (automatic)

If you name the file `terraform.tfvars` or `*.auto.tfvars`, Terraform loads it automatically. Convention: one directory per environment, each with its own `terraform.tfvars`. No flag needed — running `terraform plan` in the `prod/` directory picks up prod values automatically.

### Option C: Remote config with SSM Parameter Store

```hcl
data "aws_ssm_parameter" "desired_count" {
  name = "/winamax/prod/bet-validator/desired_count"
}

resource "aws_ecs_service" "bet_validator" {
  desired_count = tonumber(data.aws_ssm_parameter.desired_count.value)
}
```

This externalizes config from `.tf` files. Useful when non-Terraform processes need to read or write the same values. Less common for infrastructure sizing; more common for application configuration.

---

## AWS account isolation (the gold standard)

For maximum isolation, each environment runs in a separate AWS account:

```
winamax-prod-account    (123456789012)
winamax-staging-account (234567890123)
winamax-dev-account     (345678901234)
winamax-shared-account  (456789012345)  # ECR, artifact storage
```

Terraform assumes a role in the target account:

```hcl
provider "aws" {
  region = "eu-west-3"
  assume_role {
    role_arn = "arn:aws:iam::123456789012:role/TerraformDeployRole"
  }
}
```

Benefits:
- An IAM misconfiguration in dev cannot affect prod resources
- Billing is isolated per environment
- Service limits (EC2 quotas, etc.) are isolated
- Security blast radius is contained

Cost: more accounts to manage, cross-account networking if needed.

For Winamax at scale, multi-account is likely the architecture. If asked, frame it as: "I would recommend AWS Organizations with separate accounts per environment, managed by a landing zone (Control Tower or custom). Terraform assumes an environment-specific role. No engineer has direct prod access — only CI/CD does."

---

## Environment promotion pattern

Changes flow in one direction: dev → staging → prod.

```
Pull Request
    │
    ├── terraform plan against dev  (auto)
    ├── review plan
    └── merge
         │
         ├── terraform apply to dev  (auto)
         ├── tests pass
         └── promote to staging
              │
              ├── terraform plan against staging
              ├── review plan
              └── approve
                   │
                   ├── terraform apply to staging
                   ├── smoke tests pass
                   └── promote to prod
                        │
                        ├── terraform plan against prod
                        ├── senior review required
                        └── approve
                             │
                             └── terraform apply to prod
```

The module code is the same at each stage. Only the variable values (sizing, counts) differ. A change proven safe in staging has high confidence in prod — the only variable is scale.

---

## What to say in the interview

> "For environment separation, I use separate Terraform roots per environment pointing to separate state files. Each environment directory has its own backend config and tfvars file. In CI/CD, the pipeline is parameterized by environment — the same GitHub Actions workflow runs with different variable files and assumes a different IAM role based on which branch triggered the run. We do not use workspaces for persistent environments because a workspace selection mistake could apply prod changes without any guardrail. For blast radius containment, I would advocate for separate AWS accounts per environment managed through AWS Organizations."
