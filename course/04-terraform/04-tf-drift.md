# Drift Detection: What It Is, Why It Happens, How to Detect and Remediate

## What drift is

**Drift** = a divergence between what Terraform's state says exists and what actually exists in the cloud provider.

```
Terraform state says:   aws_ecs_service.bet_validator desired_count = 3
AWS API actually has:   aws_ecs_service.bet_validator desired_count = 10
```

That is drift. Terraform thinks it owns a service with 3 tasks. Someone (or something) changed the real service to 10 tasks — outside Terraform.

---

## Why drift happens

### 1. Manual console changes

The most common cause. An engineer is troubleshooting a prod incident at 3 AM. They open the AWS console and change a security group rule to allow temporary access. They fix the incident. They forget to revert or update the Terraform code.

Next `terraform plan`: that security group rule appears as a change Terraform wants to remove (restoring the state).

### 2. Autoscaling

ECS autoscaling changes `desired_count` based on load. If Terraform manages the ECS service including `desired_count`, every autoscaling event creates drift. Fix: use `ignore_changes` for autoscaling-managed attributes:

```hcl
resource "aws_ecs_service" "bet_validator" {
  desired_count = 3

  lifecycle {
    ignore_changes = [desired_count]  # managed by autoscaling, not Terraform
  }
}
```

### 3. AWS-side modifications

AWS modifies some resources automatically:
- Security group rules added by AWS services
- RDS minor version upgrades
- Certificate renewals
- Tags added by AWS Config or organization policies

Fix: `ignore_changes` for attributes AWS manages.

### 4. Partial applies

`terraform apply` runs, creates 8 of 12 resources, then the network drops. The apply fails midway. State now reflects 8 resources; the plan shows the remaining 4. This is actually normal Terraform recovery, not real drift — re-running `terraform apply` picks up where it left off.

### 5. Resources deleted outside Terraform

An engineer accidentally deletes an S3 bucket through the console or CLI. Terraform state still references it. Next plan: Terraform sees the resource is gone, plans to recreate it. Or worse: Terraform errors out because it cannot read the resource's attributes.

### 6. Drift from another Terraform root

Root A creates a VPC. Root B reads its output and creates a security group. Someone applies Root A with a change that deletes and recreates the VPC with a new ID. Root B's security group is now attached to a non-existent VPC.

---

## How to detect drift

### Manual detection: `terraform plan`

The simplest detector. If `terraform plan` output is non-empty, there is either a pending code change or drift.

```bash
terraform plan -detailed-exitcode
# Exit code 0: no changes (no drift)
# Exit code 1: error
# Exit code 2: changes present (diff exists — could be code change or drift)
```

### Automated detection: scheduled plan in CI

```yaml
# .github/workflows/drift-detection.yml
name: Drift Detection

on:
  schedule:
    - cron: '0 */6 * * *'  # every 6 hours
  workflow_dispatch:         # allow manual trigger

jobs:
  detect-drift:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        root:
          - infra/prod/vpc
          - infra/prod/ecs-cluster
          - infra/prod/rds
          - infra/prod/msk

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/TerraformDriftDetectionRole
          aws-region: eu-west-3

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.7.0"

      - name: Terraform Init
        working-directory: ${{ matrix.root }}
        run: terraform init

      - name: Terraform Plan
        id: plan
        working-directory: ${{ matrix.root }}
        run: terraform plan -detailed-exitcode -no-color 2>&1
        continue-on-error: true

      - name: Alert on drift
        if: steps.plan.outcome == 'failure' || steps.plan.outputs.exitcode == '2'
        uses: actions/github-script@v7
        with:
          script: |
            // Post to Slack, PagerDuty, or GitHub issue
            console.log('Drift detected in ${{ matrix.root }}');
            // In production: call Slack webhook with plan output
```

### `terraform refresh` (use with caution)

```bash
terraform refresh
```

This reads the current state of all managed resources from the provider API and updates the state file to match reality. **It does not change your `.tf` files** — it just updates state. After a refresh, `terraform plan` shows what Terraform would do to restore your `.tf` file's desired state.

Warning: `terraform refresh` can mask drift if you are not careful. If AWS deleted a resource and you refresh, Terraform removes it from state. Then plan tries to recreate it. This is correct behavior, but it can surprise you.

In Terraform 1.x, `terraform plan -refresh-only` is the explicit form:

```bash
terraform plan -refresh-only       # show what state would change to match reality
terraform apply -refresh-only      # update state to match reality (no infra changes)
```

---

## Remediation strategies

### Strategy 1: Revert the drift (restore desired state)

If the drift is unintentional (a manual change that should not have been made):
1. Run `terraform plan` — it shows the drift as a pending change
2. Run `terraform apply` — restores the desired state defined in `.tf` files
3. The manual change is reverted

This is the right answer when `.tf` files are the source of truth and the manual change was unauthorized.

### Strategy 2: Accept the drift (update `.tf` files)

If the manual change was intentional and should be permanent:
1. Update the `.tf` files to match the current AWS state
2. Run `terraform plan` — should show no changes (empty plan confirms state matches code)
3. Commit the `.tf` change

This is the right answer when the manual change represented a better configuration.

### Strategy 3: Import the drift

If a new resource was created outside Terraform that you now want to manage:

```bash
# Find the resource ID in AWS console or CLI
terraform import aws_security_group.new_rule sg-0abc123def456

# Then write the matching .tf declaration
# terraform plan should show no changes if the declaration matches reality
```

### Strategy 4: Ignore the drift

If the drift is from AWS-managed attributes that you do not control:

```hcl
resource "aws_ecs_service" "bet_validator" {
  lifecycle {
    ignore_changes = [
      desired_count,        # managed by autoscaling
      task_definition,      # managed by deployment pipeline
    ]
  }
}
```

---

## Drift prevention practices

| Practice | How it prevents drift |
|----------|----------------------|
| IAM policy: deny console resource modifications in prod | Operators cannot make unauthorized changes |
| AWS Config rules | Detect non-compliant resources in near real-time |
| SCPs (Service Control Policies) in AWS Org | Block entire categories of operations at the account level |
| Tagging policy: `ManagedBy = terraform` | Makes unmanaged resources visible |
| Scheduled drift detection | Finds drift before it causes incidents |
| Change management process | Manual changes require a ticket, which triggers a `.tf` update |

---

## Drift in a Winamax interview

If asked "how would you implement drift management at Winamax?"

> "Drift detection is a scheduled job in CI that runs `terraform plan -detailed-exitcode` against each Terraform root every 4-6 hours. If the exit code is 2 (changes present), it fires a Slack alert to the platform team with the plan output. The alert distinguishes between two cases: drift from unauthorized manual changes (remediate by reverting — run `terraform apply`) and drift from autoscaling or AWS-managed attributes (suppress by adding `ignore_changes` to the resource).
>
> Prevention is more important than detection: we restrict console write access in production using IAM policies and SCPs, so the only path to infrastructure changes is through the Terraform CI/CD pipeline. For resources that must be modified at runtime (ECS service desired count, task definition version), we use `ignore_changes` to tell Terraform it does not own those attributes."
