# Secrets in Terraform: Never in State, How to Inject Safely

## The problem

Terraform state is a JSON file. Every attribute of every managed resource is recorded in it — including database passwords, API keys, and private keys that some resources expose as outputs.

```json
// In terraform.tfstate — this is real
{
  "resources": [{
    "type": "aws_db_instance",
    "instances": [{
      "attributes": {
        "password": "supersecretpassword123",
        ...
      }
    }]
  }]
}
```

If your state file is:
- Committed to git → secret is in git history forever
- Stored in an S3 bucket without encryption → secret is readable by anyone with S3 access
- Printed in CI logs → secret is in log history

The state file must be encrypted at rest and access-controlled. But even with that, the goal is to minimize what ends up in state at all.

---

## Rule 1: Never hardcode secrets in `.tf` files

```hcl
# WRONG — secret is in version control
resource "aws_db_instance" "main" {
  password = "hardcoded_password"
}

# WRONG — variable passed from CLI but logged in CI
resource "aws_db_instance" "main" {
  password = var.db_password
  # terraform apply -var="db_password=hardcoded_password" ← in CI log
}
```

---

## Rule 2: Use AWS Secrets Manager or SSM Parameter Store as the source of truth

### Pattern A: Generate the secret in Terraform, store in Secrets Manager

```hcl
# Generate a random password
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

# Store it in Secrets Manager
resource "aws_secretsmanager_secret" "db_password" {
  name                    = "winamax/prod/rds/master-password"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db.result
}

# Use it in the RDS resource
resource "aws_db_instance" "main" {
  identifier = "winamax-prod"
  password   = random_password.db.result

  # State still contains the password — but state is encrypted in S3
}
```

The password IS in state (unavoidable — RDS needs it at creation). But it is not in `.tf` files or CI logs. State is encrypted at rest (S3 SSE). Access to the state bucket requires IAM permissions.

### Pattern B: Pre-created secret, Terraform only references it

```hcl
# Secret is created and managed outside Terraform (manually or by a secrets management tool)
# Terraform reads it to pass to the application — does NOT store the value
data "aws_secretsmanager_secret_version" "db_password" {
  secret_id = "winamax/prod/rds/master-password"
}

# Pass to ECS task via Secrets — value never touches Terraform state
resource "aws_ecs_task_definition" "bet_validator" {
  family = "bet-validator"

  container_definitions = jsonencode([{
    name  = "bet-validator"
    image = "123456789.dkr.ecr.eu-west-3.amazonaws.com/bet-validator:latest"

    secrets = [
      {
        name      = "DB_PASSWORD"
        valueFrom = data.aws_secretsmanager_secret_version.db_password.arn
      }
    ]
  }])
}
```

With this pattern: the secret value is never in Terraform state. Terraform only stores the ARN of the secret. ECS resolves the secret at task launch time by calling Secrets Manager directly.

---

## How ECS resolves secrets at runtime

```
ECS Task Launch
     │
     ├─ ECS reads task definition
     ├─ Sees secrets[] with Secrets Manager ARNs
     ├─ Calls Secrets Manager API (using task execution role)
     ├─ Injects secret values as environment variables
     └─ Container starts with secret available as env var
```

The task execution role needs permission to read the secret:

```hcl
resource "aws_iam_role_policy" "task_execution_secrets" {
  role = aws_iam_role.task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [
        "arn:aws:secretsmanager:eu-west-3:*:secret:winamax/prod/*"
      ]
    }]
  })
}
```

---

## Rule 3: Mark sensitive outputs

If a Terraform output contains a secret value, mark it sensitive so Terraform redacts it from plan/apply logs:

```hcl
output "db_password" {
  value     = random_password.db.result
  sensitive = true   # redacted in terminal output: (sensitive value)
}
```

Still in state — but not in CI logs.

---

## Rule 4: Encrypt state at rest

```hcl
terraform {
  backend "s3" {
    bucket  = "winamax-terraform-state"
    key     = "prod/rds/terraform.tfstate"
    region  = "eu-west-3"
    encrypt = true          # SSE-S3 encryption at rest

    # For stronger control: SSE-KMS with a customer-managed key
    # kms_key_id = "arn:aws:kms:eu-west-3:123456789012:key/abc123"
  }
}
```

Also: bucket versioning (so you can recover from accidental corruption), bucket policy (deny public access), and S3 access logging.

---

## The `TF_VAR_` pattern for CI (last resort)

When a secret must be passed as a Terraform variable (e.g., an API key for a provider):

```yaml
# GitHub Actions — secret stored in GitHub Secrets, passed as env var
- name: Terraform Apply
  env:
    TF_VAR_some_api_key: ${{ secrets.SOME_API_KEY }}
  run: terraform apply -auto-approve
```

`TF_VAR_some_api_key` is automatically picked up as `var.some_api_key` in Terraform. The value comes from GitHub Secrets (encrypted at rest, not in logs), not from the `.tf` file. This is acceptable when the secret cannot come from Secrets Manager or SSM.

---

## Summary: secrets handling hierarchy

| Where | Acceptable? | Notes |
|-------|-------------|-------|
| Hardcoded in `.tf` | Never | In version control forever |
| Terraform variable from CLI | No | Logged in shell history and CI output |
| `TF_VAR_` from CI secret | Acceptable (last resort) | Not in code, not in logs |
| SSM Parameter Store | Good | Terraform reads ARN, not value |
| Secrets Manager | Best | Native ECS integration, rotation support |
| State file (encrypted S3) | Unavoidable for some | Minimize what ends up here; encrypt always |
