# Module 4 Exercises — Terraform: IaC, CI/CD, Drift Management

These exercises test operational judgment. The goal is answers you can defend to a Winamax SRE who wrote production Terraform at scale.

---

## Exercise 1: Design the Terraform root structure for Winamax prod

### Scenario

You are joining the Winamax platform team as the first engineer to systematize Terraform. Currently infrastructure is a mix of console-created resources and one-off scripts. You need to design the Terraform root structure before any import work begins.

The production environment includes:
- 3 VPCs (main, management, data)
- ECS cluster (Fargate + EC2 capacity providers)
- 40+ ECS services (each with its own IAM role, security group, target group, CloudWatch log group)
- 3 MSK clusters (Kafka)
- 12 RDS instances (PostgreSQL, MySQL)
- ECR registries (one per service)
- ALB (1 external, 1 internal)
- S3 buckets (~80 buckets)
- Lambda functions (~20)

Requirements:
- Engineers must not be able to accidentally apply prod changes from the staging directory
- A blast radius for any single apply must be bounded (no single apply affects all 40 services)
- State must be isolated so parallel work is possible
- Import will be done incrementally over 3 months

### Your task

1. Design the directory structure for Terraform roots under `infra/prod/`
2. Define the state file key scheme in S3
3. Explain how you handle cross-root dependencies (e.g., a service needs the VPC ID)
4. Which roots would you import first and why?

### Solution

<details>
<summary>Expand after attempting</summary>

**Directory structure:**

```
infra/
├── modules/
│   ├── ecs-service/        # shared module for all 40 services
│   ├── rds-instance/
│   └── s3-bucket/
├── global/
│   └── ecr/                # ECR registries — not environment-specific
├── prod/
│   ├── networking/         # VPCs, subnets, IGWs, NAT gateways, route tables
│   ├── security-groups/    # shared security groups (ALB SG, management SG)
│   ├── iam-base/           # task execution role, cross-service roles
│   ├── ecs-cluster/        # cluster resource only
│   ├── alb/                # both ALBs, listeners
│   ├── msk/                # all 3 MSK clusters (or split per cluster)
│   ├── rds/                # all RDS, or split by database group
│   ├── services/
│   │   ├── bet-validator/
│   │   ├── odds-feed/
│   │   ├── fraud-detection/
│   │   └── ... (one dir per service)
│   └── lambda/
```

**State file key scheme:**

```
prod/networking/terraform.tfstate
prod/security-groups/terraform.tfstate
prod/iam-base/terraform.tfstate
prod/ecs-cluster/terraform.tfstate
prod/alb/terraform.tfstate
prod/msk/terraform.tfstate
prod/rds/terraform.tfstate
prod/services/bet-validator/terraform.tfstate
prod/services/odds-feed/terraform.tfstate
global/ecr/terraform.tfstate
```

**Cross-root dependencies — remote state data source:**

```hcl
# In prod/services/bet-validator/main.tf
data "terraform_remote_state" "networking" {
  backend = "s3"
  config = {
    bucket = "winamax-terraform-state"
    key    = "prod/networking/terraform.tfstate"
    region = "eu-west-3"
  }
}

resource "aws_security_group" "bet_validator" {
  vpc_id = data.terraform_remote_state.networking.outputs.vpc_id
}
```

The networking root must export its outputs:
```hcl
output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
```

**Import order:**

Phase 1 (week 1-2): networking, security-groups, iam-base
- No dependencies — safe to import first
- Other roots depend on these outputs

Phase 2 (week 3-4): ecs-cluster, alb, ECR
- Depend on networking being in state

Phase 3 (week 5-8): MSK and RDS
- Highest risk — import with `prevent_destroy = true` already set
- Plan carefully, do not apply without 2-person review
- Verify empty plan before considering the import done

Phase 4 (weeks 9-12): individual services (40+)
- Once platform infrastructure is in state
- Can be parallelized across team members (each service is its own root)
- Use the shared ecs-service module to write declarations efficiently

</details>

---

## Exercise 2: Implement drift detection for production

### Scenario

The Winamax platform team wants automated drift detection. Currently, drift is discovered accidentally during incident investigations ("wait, that security group rule shouldn't be there"). You need to implement a drift detection system that runs automatically and alerts the team.

Requirements:
- Runs every 6 hours
- Detects drift in all prod roots
- Posts to Slack if drift is found
- Does not fail silently (distinguish between "no drift" and "detection failed")
- The detection job must not have write permissions to AWS

### Your task

Write the GitHub Actions workflow for drift detection. Include:
1. The schedule and job structure
2. How you scope the IAM permissions (plan-only role)
3. How you distinguish "no drift" from "detection failed"
4. What you include in the Slack notification

### Solution

<details>
<summary>Expand after attempting</summary>

```yaml
# .github/workflows/drift-detection.yml
name: Terraform Drift Detection

on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

jobs:
  detect:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false   # detect drift in all roots even if one fails
      matrix:
        root:
          - prod/networking
          - prod/ecs-cluster
          - prod/alb
          - prod/msk
          - prod/rds
          - prod/services/bet-validator
          # ... all roots

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (read-only plan role)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/TerraformDriftDetectionRole
          # This role has: s3:GetObject on state bucket, describe/* on all resources
          # This role does NOT have: s3:PutObject, any write permissions
          aws-region: eu-west-3

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.7.0"

      - name: Init
        working-directory: infra/${{ matrix.root }}
        run: terraform init -input=false

      - name: Plan (drift check)
        id: plan
        working-directory: infra/${{ matrix.root }}
        run: |
          terraform plan \
            -detailed-exitcode \
            -no-color \
            -input=false \
            2>&1 | tee plan_output.txt
          echo "exit_code=${PIPESTATUS[0]}" >> $GITHUB_OUTPUT
        continue-on-error: true

      - name: Notify Slack on drift
        if: steps.plan.outputs.exit_code == '2'
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_PLATFORM_WEBHOOK }}
        run: |
          PLAN_EXCERPT=$(head -50 infra/${{ matrix.root }}/plan_output.txt)
          curl -X POST "$SLACK_WEBHOOK" \
            -H 'Content-type: application/json' \
            --data "{
              \"text\": \":warning: *Terraform Drift Detected*\",
              \"attachments\": [{
                \"color\": \"warning\",
                \"fields\": [
                  {\"title\": \"Root\", \"value\": \"${{ matrix.root }}\", \"short\": true},
                  {\"title\": \"Run\", \"value\": \"<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Details>\", \"short\": true},
                  {\"title\": \"Plan Excerpt\", \"value\": \"\`\`\`${PLAN_EXCERPT}\`\`\`\"}
                ]
              }]
            }"

      - name: Notify Slack on detection failure
        if: steps.plan.outputs.exit_code == '1'
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_PLATFORM_WEBHOOK }}
        run: |
          curl -X POST "$SLACK_WEBHOOK" \
            -H 'Content-type: application/json' \
            --data "{
              \"text\": \":red_circle: *Drift Detection Failed* — could not run plan for \`${{ matrix.root }}\`. Check the run for errors.\",
              \"attachments\": [{
                \"color\": \"danger\",
                \"fields\": [{
                  \"title\": \"Run\",
                  \"value\": \"<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Details>\"
                }]
              }]
            }"

      - name: Fail job on plan error (exit code 1)
        if: steps.plan.outputs.exit_code == '1'
        run: exit 1
        # exit code 2 (drift) is reported but does not fail the job
        # the team reviews and remediates; it is not a CI failure
```

**Key design decisions:**

1. `fail-fast: false` — if bet-validator has drift, continue checking rds. Do not stop after first drift.

2. Exit code semantics:
   - `0` = no changes = no drift = silent success
   - `1` = plan errored = detection failure = alert + fail the job (something is broken)
   - `2` = changes present = drift detected = alert + do not fail the job (team remediates)

3. IAM role is read-only — the drift detection job cannot accidentally apply anything. Even if the workflow is compromised, the role has no write permissions.

4. Plan excerpt in Slack — the first 50 lines of the plan give the on-call engineer enough context to understand what drifted before opening the full run.

</details>

---

## Exercise 3: Safely import an RDS instance

### Scenario

Winamax runs a PostgreSQL RDS instance (`winamax-prod-postgres`) that was created via the console in 2019. It holds 15 TB of betting data. You need to bring it under Terraform management.

The instance details (from AWS console):
- Identifier: `winamax-prod-postgres`
- Engine: PostgreSQL 15.4
- Instance class: db.r6g.2xlarge
- Multi-AZ: yes
- Deletion protection: enabled (in AWS)
- Automated backups: 7 days
- VPC: `vpc-0abc123def456789`

### Your task

Walk through the complete import process:
1. Write the initial `.tf` declaration
2. Show the import command
3. Describe what the post-import plan might show and how you fix each difference
4. What safeguards do you set before running any `terraform apply`?

### Solution

<details>
<summary>Expand after attempting</summary>

**Step 1: Write the `.tf` declaration (start minimal)**

```hcl
resource "aws_db_instance" "main" {
  identifier = "winamax-prod-postgres"
  
  # Safeguards FIRST — before import, before apply
  deletion_protection = true
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [password, engine_version]
  }
}
```

Add safeguards before importing. If something goes wrong with the declaration, `prevent_destroy` ensures Terraform cannot generate a plan to destroy the database.

**Step 2: Import**

```bash
cd infra/prod/rds
terraform init
terraform import aws_db_instance.main winamax-prod-postgres
```

Terraform reads the instance's current state from AWS and writes it to `terraform.tfstate`.

**Step 3: Run plan and fix differences**

```bash
terraform plan
```

Common differences you will see and how to address each:

```
~ password   = (known after apply)
```
Fix: Add `ignore_changes = [password]` — Terraform cannot read the current password from AWS, so it always wants to change it. Ignore it.

```
~ engine_version = "15.4" -> "15.3"
```
Fix: Update `.tf` to `engine_version = "15.4"` OR add to `ignore_changes` if AWS manages minor version upgrades.

```
+ performance_insights_enabled = false
```
Fix: Add `performance_insights_enabled = true` to match reality (or false if it is actually disabled).

```
~ parameter_group_name = "default.postgres15" -> null
```
Fix: Add `parameter_group_name = "default.postgres15"` to `.tf`.

Keep running `terraform plan` and fixing differences until the plan is empty.

**Step 4: Verify empty plan = import complete**

```bash
terraform plan
# Output: No changes. Your infrastructure matches the configuration.
```

Only commit when the plan is empty. An empty plan means the `.tf` file exactly describes the running database.

**What you do NOT do:**

- Do not run `terraform apply` while the plan is non-empty (you would change the live RDS instance)
- Do not remove `prevent_destroy` before the import is complete and verified
- Do not use `terraform destroy` test or `-target` tricks — the blast radius is 15 TB of data

</details>

---

## Exercise 4: Debug a broken plan in CI

### Scenario

The Terraform CI plan on a PR fails with:

```
Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: ...
Lock Info:
  ID:        a3b4c5d6-7890-abcd-ef12-34567890abcd
  Path:      s3://winamax-terraform-state/prod/ecs-cluster/terraform.tfstate
  Operation: OperationTypeApply
  Who:       github-actions@runner-1
  Version:   1.7.0
  Created:   2026-04-01 02:14:33.123456789 UTC
  Info:
```

The lock was acquired 6 hours ago. There is no running GitHub Actions job that should hold it.

### Your task

1. What happened?
2. How do you verify it is safe to force-unlock?
3. Show the command to release the lock.
4. How do you prevent this from recurring?

### Solution

<details>
<summary>Expand after attempting</summary>

**What happened:**

A GitHub Actions apply job started 6 hours ago, acquired the state lock, and then the runner was interrupted — either the job timed out, the runner crashed, or GitHub cancelled the run. The `terraform apply` process was killed mid-execution. The lock was never released because the cleanup step did not run.

**The risk:** If the apply was mid-execution, the state file may be partially updated. Resources may have been created that are not yet in state. This is a partial apply state.

**Verify before force-unlocking:**

1. Check GitHub Actions — find the run from 6 hours ago. What was its status? Cancelled, timed out, or errored? What was the last resource it was processing?

2. Check AWS — did the resources the apply was creating actually get created?
   ```bash
   aws ecs describe-services --cluster winamax-prod --services bet-validator
   ```

3. Check S3 — is there a state backup from before the apply?
   ```bash
   aws s3api list-object-versions \
     --bucket winamax-terraform-state \
     --prefix prod/ecs-cluster/terraform.tfstate
   ```

4. If the apply was in progress and created partial resources: restore the previous state version from S3, fix the partial resources manually, then run `terraform apply` fresh.

**Force-unlock (only after confirming the lock owner is dead):**

```bash
cd infra/prod/ecs-cluster
terraform force-unlock a3b4c5d6-7890-abcd-ef12-34567890abcd
```

You must provide the exact lock ID from the error message.

**Prevention:**

1. Set a job timeout in GitHub Actions:
   ```yaml
   jobs:
     terraform-apply:
       timeout-minutes: 30   # fail the job rather than hanging indefinitely
   ```

2. Use saved plan files — plan → artifact → apply. If the apply is cancelled, the next run re-plans from scratch.

3. Monitor for stale locks: add a check that alerts if the DynamoDB lock table has entries older than 30 minutes that do not correspond to a running CI job.

</details>

---

## Exercise 5: Design secrets injection for a new ECS service

### Scenario

You are adding a new ECS service: `payment-processor`. It needs:
- A PostgreSQL connection string (sensitive)
- A third-party payment API key (sensitive)
- A Kafka bootstrap URL (not sensitive — just config)
- An environment identifier (`prod`, `staging`)

The security team requires:
- Secrets must not appear in Terraform state if avoidable
- Secrets must be rotatable without a Terraform change
- The payment API key must be accessible only to `payment-processor`, not other services

### Your task

Write the complete Terraform configuration for secrets injection into the ECS task definition. Include:
1. How each value is stored and accessed
2. The IAM policy that scopes access to only payment-processor
3. The task definition `secrets` and `environment` blocks

### Solution

<details>
<summary>Expand after attempting</summary>

**Storage:**

```hcl
# PostgreSQL connection string — in Secrets Manager (rotatable, not in state)
resource "aws_secretsmanager_secret" "payment_db_url" {
  name = "winamax/prod/payment-processor/db-url"
  description = "PostgreSQL connection string for payment-processor"
  recovery_window_in_days = 7
}
# Value set manually or by rotation Lambda — NOT by Terraform
# This means the value never touches Terraform state

# Payment API key — in Secrets Manager
resource "aws_secretsmanager_secret" "payment_api_key" {
  name = "winamax/prod/payment-processor/payment-api-key"
  description = "Third-party payment API key — scoped to payment-processor only"
  recovery_window_in_days = 7
}
# Value set out-of-band

# Non-sensitive config — environment variable (no secrets needed)
locals {
  kafka_bootstrap = aws_msk_cluster.main.bootstrap_brokers_sasl_iam
}
```

**IAM — scoped access:**

```hcl
resource "aws_iam_role_policy" "payment_processor_secrets" {
  role = aws_iam_role.payment_processor_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.payment_db_url.arn,
        aws_secretsmanager_secret.payment_api_key.arn,
        # Scoped to these two secrets only — no wildcard
      ]
    }]
  })
}
```

The task execution role also needs `secretsmanager:GetSecretValue` for the same ARNs (ECS agent resolves secrets at launch using the execution role, not the task role).

**Task definition:**

```hcl
resource "aws_ecs_task_definition" "payment_processor" {
  family                   = "payment-processor"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.payment_processor_task_execution.arn
  task_role_arn            = aws_iam_role.payment_processor_task.arn

  container_definitions = jsonencode([{
    name      = "payment-processor"
    image     = "${aws_ecr_repository.payment_processor.repository_url}:${var.image_tag}"
    essential = true

    # Sensitive — resolved by ECS from Secrets Manager, never in state
    secrets = [
      {
        name      = "DB_URL"
        valueFrom = aws_secretsmanager_secret.payment_db_url.arn
      },
      {
        name      = "PAYMENT_API_KEY"
        valueFrom = aws_secretsmanager_secret.payment_api_key.arn
      }
    ]

    # Non-sensitive — inline environment variables (in state, acceptable)
    environment = [
      { name = "KAFKA_BROKERS", value = local.kafka_bootstrap },
      { name = "ENV",           value = var.environment }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/payment-processor"
        "awslogs-region"        = "eu-west-3"
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}
```

**Why this design:**
- Secret values are never in Terraform state (secrets created empty, values managed outside Terraform)
- Rotation: update the secret value in Secrets Manager → redeploy ECS task → new task reads new value → zero Terraform changes needed
- Scope: the IAM policy grants access to exactly 2 ARNs — no other service's task role can read these secrets
- `KAFKA_BROKERS` is a URL, not a secret — injecting it as a plain env var is correct

</details>
