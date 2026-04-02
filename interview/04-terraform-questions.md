# Module 4 Interview Questions — Terraform

These are the questions a Winamax SRE will ask. Each answer is framed for someone with strong K8s background translating into Terraform/AWS.

---

## Fundamentals

**Q: What is Terraform state and why does it matter?**

> State is Terraform's record of what it has created — a JSON mapping from `.tf` resource declarations to real-world infrastructure IDs and attributes. Without state, Terraform cannot know which AWS resource corresponds to which declaration, cannot detect drift, and cannot safely destroy or modify resources.
>
> State matters operationally because it must be protected. It often contains sensitive values. It must be stored remotely for teams (S3 + DynamoDB for AWS). Corruption or loss of state is a serious incident — you lose the mapping between code and reality.
>
> In contrast, Kubernetes stores desired state in etcd and derives current state by querying the API server directly. Terraform maintains its own state file, which is why state management is a first-class concern in Terraform that has no equivalent in kubectl operations.

---

**Q: Explain `terraform plan` vs `terraform apply`.**

> `plan` is a read-only operation. Terraform reads the `.tf` files (desired state), reads the current state file, and calls provider APIs to check the actual current state of resources. It generates an execution plan showing what would change: `+` create, `-` destroy, `~` modify in-place, `-/+` destroy and recreate.
>
> `apply` executes the plan — it calls provider APIs to make real changes. In CI/CD, I always run `terraform plan -out=tfplan` to save the plan, have a human review it, then `terraform apply tfplan` to execute exactly what was reviewed. Never apply without reviewing the plan.
>
> The dangerous symbol is `-/+` (destroy and recreate). Some attribute changes on some resources force replacement. For a database, `-/+` means destroy the running instance and create a new empty one. Always read replacement-flagged resources before approving an apply.

---

**Q: What is the difference between a Terraform resource and a data source?**

> A resource is something Terraform creates, manages, and can destroy — it is in Terraform's state. A data source is a read-only query to the provider API — Terraform reads an existing resource but does not manage it, does not put it in state, and cannot destroy it.
>
> Use a resource for infrastructure you own. Use a data source for infrastructure owned by another team or another Terraform root. For example: I manage my ECS service with a resource. I read the VPC created by the networking team using a data source — I do not own that VPC and should not be able to destroy it.

---

## State management

**Q: How do you set up remote state for a team using Terraform on AWS?**

> S3 + DynamoDB: S3 bucket stores the state file (versioned, encrypted at rest), DynamoDB table provides a distributed lock. The backend config in `.tf`:
>
> ```hcl
> terraform {
>   backend "s3" {
>     bucket         = "company-terraform-state"
>     key            = "prod/ecs-cluster/terraform.tfstate"
>     region         = "eu-west-3"
>     encrypt        = true
>     dynamodb_table = "company-terraform-locks"
>   }
> }
> ```
>
> Each independent unit of infrastructure gets its own state key — one key per Terraform root. This limits blast radius and allows parallel work. A single global state file is an anti-pattern: it creates a serialization bottleneck and an enormous blast radius for any single apply.

---

**Q: Workspaces vs separate directories — which do you use for environment separation and why?**

> I use separate directories (separate roots) for persistent environments like dev, staging, and prod. Workspaces are technically state isolation, but they use the same `.tf` files. The footgun: `terraform workspace select prod` when you meant `staging` applies prod changes with no guardrail. There is no confirmation that tells you which workspace you're in.
>
> Separate directories are structurally safer: to apply prod changes, you must be physically in `infra/prod/`. There is no command available from `infra/staging/` that can reach prod state.
>
> I use workspaces for ephemeral environments — spinning up identical copies of an environment for testing or feature branches — where the workspace-selection risk is lower and the structural sameness of the environments is a benefit.

---

**Q: How do you pass values between Terraform roots?**

> Through outputs and remote state data sources. Root A exports an output value. Root B reads it using `data "terraform_remote_state"`:
>
> ```hcl
> data "terraform_remote_state" "vpc" {
>   backend = "s3"
>   config = {
>     bucket = "company-terraform-state"
>     key    = "prod/vpc/terraform.tfstate"
>     region = "eu-west-3"
>   }
> }
>
> resource "aws_security_group" "my_service" {
>   vpc_id = data.terraform_remote_state.vpc.outputs.vpc_id
> }
> ```
>
> This creates an explicit dependency: Root A must be applied before Root B can be applied. If Root A's outputs do not exist (first apply or state deleted), Root B's plan fails. This dependency is a feature — it makes the apply order explicit and correct.

---

## CI/CD

**Q: How do you implement Terraform CI/CD so that no engineer applies from their laptop?**

> Plan on PR, apply on merge. The GitHub Actions workflow:
>
> 1. On PR open/push: `terraform plan` runs, output is posted as a PR comment. Engineers review the plan as part of code review.
> 2. On merge to main: `terraform apply` runs automatically with the reviewed plan file.
>
> Authentication: OIDC from GitHub Actions to AWS — no long-lived keys. The plan job assumes a read-only role. The apply job assumes a write role, scoped to the target environment.
>
> Engineers' local AWS credentials have read-only access to production. `terraform apply` from a laptop against prod would fail at the IAM level even if someone tried. The only path to a prod change is through the CI pipeline.

---

**Q: What is the plan file pattern and why is it important?**

> `terraform plan -out=tfplan` saves the execution plan to a binary file. `terraform apply tfplan` executes exactly that plan — not a new plan computed at apply time.
>
> Why it matters: between the time a plan is reviewed on a PR and the time apply runs on merge, the environment can change. A new plan at apply time might include additional changes that were not reviewed. The plan file ensures that what was reviewed is exactly what gets applied.
>
> In CI: upload the plan file as a job artifact after the plan step. Download it in the apply step. If the artifact is expired or missing, the apply job fails — a safe failure that requires a new PR with a fresh plan.

---

## Drift

**Q: What is Terraform drift and how do you detect and remediate it?**

> Drift is when the real AWS state diverges from what Terraform's state file says. Causes: manual console changes, AWS-side automatic modifications (autoscaling, minor version upgrades), partial applies, or resources modified by other automation.
>
> Detection: `terraform plan -detailed-exitcode` — exit code 2 means changes are present (either code change or drift). I run this on a schedule (every 4-6 hours) across all Terraform roots as a scheduled GitHub Actions job. If exit code is 2, it posts to Slack.
>
> Remediation has two paths: if the drift is unauthorized (someone changed the console), run `terraform apply` to restore desired state. If the drift is intentional and should be permanent, update the `.tf` files to match reality, run plan to confirm empty, commit.
>
> Prevention is more important than detection: restrict console write access in prod via IAM policies and SCPs. Make Terraform the only path to infrastructure changes.

---

**Q: An ECS service's `desired_count` drifts every hour. Why and how do you fix it?**

> ECS autoscaling is changing the desired count based on load. Terraform's `desired_count` attribute records the value from the last `terraform apply`. When autoscaling changes it, the next `terraform plan` shows drift.
>
> Fix: tell Terraform to ignore that attribute.
>
> ```hcl
> resource "aws_ecs_service" "bet_validator" {
>   desired_count = 3   # the initial/minimum value
>
>   lifecycle {
>     ignore_changes = [desired_count]
>   }
> }
> ```
>
> Terraform provisions the service with `desired_count = 3` on first apply. Autoscaling takes over from there. On every subsequent plan, Terraform ignores the drift in desired_count.
>
> Same pattern for `task_definition` if you deploy new task definitions outside Terraform (e.g., a separate deployment pipeline).

---

## Secrets

**Q: How do you handle secrets in Terraform? What must never happen?**

> Three hard rules:
>
> 1. Secrets never in `.tf` files — they go into version control.
> 2. Secrets in Terraform state are unavoidable for some resources (e.g., RDS password at creation), but state must be encrypted at rest (S3 SSE) and access-controlled.
> 3. Secret values should flow through AWS Secrets Manager or SSM, not through Terraform state.
>
> The best pattern for ECS: create the Secrets Manager secret resource in Terraform (stores the ARN in state, not the value), set the value out-of-band (manually or via rotation Lambda), and reference the ARN in the ECS task definition's `secrets` block. ECS resolves the secret value at task launch time. The actual password never touches Terraform state.
>
> For CI/CD: use OIDC authentication (no long-lived AWS keys). If a secret must be passed as a Terraform variable, use `TF_VAR_` from a CI secret store — it is not in logs or code, but this is a last resort.

---

## Import and refactoring

**Q: How do you import existing infrastructure into Terraform?**

> The classic approach: `terraform import <resource_type>.<name> <aws_id>`. But before importing, write the `.tf` declaration with `prevent_destroy = true` and `lifecycle { ignore_changes = [...] }`. Import links the state entry to the declaration. Then run `terraform plan` and fix differences until the plan is empty. Never run `terraform apply` on a non-empty post-import plan against a live resource — you will change the real infrastructure to match your possibly-incorrect declaration.
>
> The modern approach (Terraform 1.5+): declarative `import {}` blocks in the `.tf` file. They run through normal plan/apply and are code-reviewed. `terraform plan -generate-config-out=generated.tf` auto-generates the declaration. Clean up the generated file, verify empty plan, commit.
>
> For a database with 15 TB of data: I set `prevent_destroy = true` and `deletion_protection = true` before I write a single import command. Even if the declaration is wrong, Terraform cannot generate a plan to destroy it.

---

**Q: Atlantis or GitHub Actions for Terraform CI/CD — what would you recommend for Winamax?**

> I would start with GitHub Actions for a new setup: OIDC authentication is clean, no server to maintain, the PR comment integration is one scripted step. It is operationally simpler and there is no additional infrastructure to run and keep highly available.
>
> Atlantis makes sense at very large Terraform footprint — it has native support for detecting which roots changed on a PR and has stronger plan-to-apply locking than DynamoDB state locking alone. At Winamax's scale (700+ services, many Terraform roots), Atlantis becomes attractive. But it is a stateful server — if Atlantis goes down, no Terraform changes can merge, so it needs HA deployment and monitoring.
>
> The choice of tool matters less than the discipline: every apply goes through a reviewed plan, no one applies from their laptop, and AWS credentials are short-lived.

---

## Scenario questions

**Q: You run `terraform plan` and see a `-/+` (destroy and recreate) on your RDS instance. What do you do?**

> Do not apply. Investigate why Terraform wants to recreate the database.
>
> Step 1: Read the plan output carefully. Which attribute changed? Terraform usually tells you what forced the replacement.
>
> Step 2: Common causes:
> - Changing `identifier` — rename is a replacement for RDS
> - Changing `db_subnet_group_name` — replacement
> - Changing encryption settings — replacement
> - Removing a security group that was the only one in the list
>
> Step 3: If the change is unintentional (wrong attribute in the `.tf` file): revert the `.tf` change. If the change is necessary: plan the migration instead — snapshot the database, apply the recreation in a maintenance window with the snapshot as the restore source. Never apply a `-/+` on a production database without a tested rollback plan.
>
> Step 4: Add `lifecycle { prevent_destroy = true }` if it is not already there. This makes Terraform refuse to generate plans with database destruction — you have to explicitly remove the lifecycle block to proceed.

---

**Q: How would you implement Terraform for Winamax's drift management requirement from the JD?**

> See the full answer in `04-tf-drift.md`. Summary for the interview:
>
> "Scheduled GitHub Actions job, runs every 6 hours, `terraform plan -detailed-exitcode` on all prod roots. Exit code 2 means changes present — fires a Slack alert with the plan excerpt. Exit code 1 means plan errored — fires a separate alert flagged as 'detection system broken, not just drift'.
>
> The detection role is read-only — no write permissions, cannot accidentally apply anything. Prevention: IAM policies and SCPs restrict prod console access. `ignore_changes` on runtime-managed attributes (desired_count, task_definition) to suppress false-positive drift alerts. Scheduled drift detection is the safety net; prevention is the first line of defense."
