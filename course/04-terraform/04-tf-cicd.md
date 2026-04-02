# CI/CD Integration: GitHub Actions + Terraform

## The goal

No engineer runs `terraform apply` from their laptop against a shared environment. Every infrastructure change goes through:

1. A PR with a plan output that reviewers can read
2. Approval
3. Automated apply on merge

This is the workflow Winamax explicitly named in the job description.

---

## The pattern: plan on PR, apply on merge

```
Developer                GitHub Actions              AWS
    │                         │                       │
    ├─ git push branch ──────►│                       │
    │                         ├─ terraform fmt check  │
    │                         ├─ terraform validate   │
    │                         ├─ terraform plan ─────►│ (read-only API calls)
    │                         ├─ post plan to PR ◄────┤
    │◄─ "here is the plan" ───┤                       │
    │                         │                       │
    ├─ PR approved ───────────►│                       │
    ├─ merge to main ─────────►│                       │
    │                         ├─ terraform apply ─────►│ (write API calls)
    │◄─ apply complete ────────┤◄──────────────────────┤
```

---

## GitHub Actions workflow

```yaml
# .github/workflows/terraform.yml
name: Terraform

on:
  pull_request:
    branches: [main]
    paths:
      - 'infra/**'
  push:
    branches: [main]
    paths:
      - 'infra/**'

permissions:
  id-token: write      # required for OIDC auth to AWS
  contents: read
  pull-requests: write # required to post plan comment

env:
  TF_VERSION: "1.7.0"
  AWS_REGION: "eu-west-3"

jobs:
  terraform-plan:
    name: Plan
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    
    strategy:
      matrix:
        environment: [staging]    # plan against staging on PR; prod on merge
    
    defaults:
      run:
        working-directory: infra/${{ matrix.environment }}/ecs-cluster

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — no long-lived keys)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::234567890123:role/GitHubActionsTerraformPlanRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}

      - name: Terraform Format Check
        id: fmt
        run: terraform fmt -check -recursive
        continue-on-error: true   # report but don't block; fix in next step

      - name: Terraform Init
        id: init
        run: terraform init

      - name: Terraform Validate
        id: validate
        run: terraform validate

      - name: Terraform Plan
        id: plan
        run: terraform plan -no-color -out=tfplan
        continue-on-error: true   # capture non-zero exit so we can post the error

      - name: Post plan to PR
        uses: actions/github-script@v7
        with:
          script: |
            const output = `#### Terraform Format \`${{ steps.fmt.outcome }}\`
            #### Terraform Validate \`${{ steps.validate.outcome }}\`
            #### Terraform Plan \`${{ steps.plan.outcome }}\`
            
            <details><summary>Show Plan</summary>
            
            \`\`\`hcl
            ${{ steps.plan.outputs.stdout }}
            \`\`\`
            
            </details>
            
            *Pushed by @${{ github.actor }}*`;
            
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: output
            });

      - name: Fail if plan failed
        if: steps.plan.outcome == 'failure'
        run: exit 1

  terraform-apply:
    name: Apply
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    environment: production    # requires manual approval in GitHub UI

    defaults:
      run:
        working-directory: infra/prod/ecs-cluster

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC — prod role)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsTerraformApplyRole
          aws-region: ${{ env.AWS_REGION }}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}

      - name: Terraform Init
        run: terraform init

      - name: Terraform Apply
        run: terraform apply -auto-approve
```

---

## OIDC authentication — no long-lived AWS keys

The workflow above uses OIDC (OpenID Connect) to authenticate to AWS. GitHub generates a short-lived token; AWS validates it and assumes the IAM role. No AWS secret keys stored in GitHub Secrets.

```hcl
# IAM: trust GitHub Actions OIDC for the plan role
resource "aws_iam_role" "github_terraform_plan" {
  name = "GitHubActionsTerraformPlanRole"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:winamax/infra:*"
        }
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

# Plan role: read-only + state read
resource "aws_iam_role_policy" "github_plan" {
  role = aws_iam_role.github_terraform_plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = ["arn:aws:s3:::winamax-terraform-state", "arn:aws:s3:::winamax-terraform-state/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem"]
        Resource = "arn:aws:dynamodb:eu-west-3:*:table/winamax-terraform-locks"
      },
      # Read-only access to plan (describe, list)
      {
        Effect   = "Allow"
        Action   = ["ecs:Describe*", "ecs:List*", "ec2:Describe*", "iam:Get*", "iam:List*"]
        Resource = "*"
      }
    ]
  })
}
```

**Plan role vs Apply role:**
- Plan role: read-only access to all resources Terraform needs to read + state bucket read
- Apply role: write access to resources Terraform manages + state bucket write + DynamoDB lock write
- Apply role is only assumed by jobs running on `main` branch, with GitHub environment protection (optional manual approval)

---

## Saving and using plan files

A subtle CI/CD issue: plan on PR → something changes in the environment → apply on merge uses a stale plan.

The safer pattern: save the plan file as an artifact on the plan job, download and apply it in the apply job:

```yaml
# In plan job:
- name: Terraform Plan
  run: terraform plan -out=tfplan

- name: Upload plan artifact
  uses: actions/upload-artifact@v4
  with:
    name: tfplan-${{ github.sha }}
    path: infra/prod/ecs-cluster/tfplan
    retention-days: 1

# In apply job:
- name: Download plan artifact
  uses: actions/download-artifact@v4
  with:
    name: tfplan-${{ github.sha }}
    path: infra/prod/ecs-cluster/

- name: Terraform Apply
  run: terraform apply tfplan   # applies the exact reviewed plan
```

This ensures what was reviewed is exactly what gets applied. If the plan artifact is missing (expired), the apply job fails — a safe failure.

---

## What not to do

**Long-lived AWS keys in GitHub Secrets:**
- Keys can be rotated but rotation requires updating the secret — manual step that gets missed
- If the secret is leaked (log exposure, insider, secret scanning failure), AWS credentials are compromised
- Use OIDC instead. It is supported by all major CI systems.

**`-auto-approve` on plan:**
```bash
terraform apply -auto-approve  # never on PR, only on automated apply after review
```

**Running apply on PR push:**
Every commit to the PR branch would apply changes to prod. Plan on PR, apply on merge. Non-negotiable.

**Terraform state in the repo:**
```
# NEVER commit these
terraform.tfstate
terraform.tfstate.backup
.terraform/
```

Add to `.gitignore`. State contains sensitive values and must live in remote storage only.

---

## Directory-targeted workflows

With 700+ services in Winamax, you do not want every PR to plan every Terraform root. Use path filters and a matrix strategy:

```yaml
on:
  pull_request:
    paths:
      - 'infra/prod/services/bet-validator/**'
```

Or use a tool like `terraform-changed-modules` to detect which roots changed and only plan/apply those.
