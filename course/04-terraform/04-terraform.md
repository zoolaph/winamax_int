# Module 4 — Terraform: IaC, CI/CD Integration, Drift Management

**Why this is high priority:** The Winamax job description names Terraform in CI/CD with drift management as a concrete deliverable — not as background context. You will be asked to describe how you would implement it, and you need to be able to defend specific decisions.

---

## What Winamax uses Terraform for

Winamax runs 700+ microservices on AWS. The infrastructure footprint includes:
- ECS clusters (Fargate + EC2), services, task definitions
- VPCs, subnets, security groups across multiple environments
- IAM roles and policies (700+ services × minimum 1 role each)
- RDS instances (50 TB of data across databases)
- MSK (Kafka) clusters
- Load balancers, target groups, listener rules
- S3 buckets, Lambda functions, CloudWatch alarms

Without Terraform: each of these is a console click or a one-off script. With Terraform: every resource is reviewable, diffable, auditable, and reproducible. At Winamax's scale, "infrastructure as code" is not a best practice — it is the only way to operate without chaos.

The named deliverables from the JD:
1. **Terraform integrated into CI/CD** — plan on PR, apply on merge, no manual `terraform apply` from laptops
2. **Drift management** — automated detection when reality diverges from state, with remediation runbooks

---

## Module structure — what each file covers

| Topic | File | One-line summary |
|---|---|---|
| Fundamentals | `04-tf-fundamentals.md` | Providers, resources, state, plan/apply lifecycle |
| State management | `04-tf-state.md` | Remote state, locking, workspaces vs separate roots |
| Module design | `04-tf-modules.md` | When to abstract, when to stay flat |
| Environment strategy | `04-tf-environments.md` | Safely separating dev/staging/prod |
| CI/CD integration | `04-tf-cicd.md` | GitHub Actions: plan on PR, apply on merge |
| Drift detection | `04-tf-drift.md` | What drift is, why it happens, how to detect and fix |
| Secrets | `04-tf-secrets.md` | Never in state — how to inject safely |
| Terraform + AWS | `04-tf-aws.md` | Common resources: ECS, IAM, VPC, RDS |
| Atlantis vs GHA | `04-tf-atlantis-vs-gha.md` | Trade-offs between the two main CI/CD approaches |
| Import & refactoring | `04-tf-import.md` | Bringing existing infra under Terraform control |

---

## Bridge from Kubernetes

You know Helm: you write a chart, run `helm upgrade --install`, and Helm compares desired state to current state and applies the diff. Terraform is the same loop:

```
Helm:      helm upgrade   → compares desired (chart) to actual (k8s API) → applies diff
Terraform: terraform plan → compares desired (.tf files) to actual (state) → shows diff
           terraform apply → executes the diff against the real provider API
```

The critical difference: **Terraform has state**. Helm derives state by querying the Kubernetes API live. Terraform stores its own state file. That state file is the source of truth for what Terraform thinks exists — if state diverges from reality, you have drift. This is why state management is a first-class concern.

---

## Part 1: Fundamentals — quick map

See `04-tf-fundamentals.md` for the full breakdown.

**The one thing to keep sharp: `plan` shows a diff, `apply` executes it. Never apply without reviewing the plan.**

The lifecycle:
1. Write `.tf` files (desired state)
2. `terraform init` — download providers, configure backend
3. `terraform plan` — compare `.tf` files against state, generate execution plan
4. Review plan — this is where you catch mistakes
5. `terraform apply` — execute plan against real infrastructure

---

## Part 2: State management — quick map

See `04-tf-state.md` for the full breakdown.

**The one thing to keep sharp: remote state + locking prevents concurrent apply disasters.**

S3 + DynamoDB is the standard AWS backend:
- S3: stores the state file (versioned)
- DynamoDB: provides a lock so two people cannot `terraform apply` simultaneously

---

## Part 3: CI/CD integration — quick map

See `04-tf-cicd.md` for the full breakdown.

**The pattern Winamax wants:** `plan` runs on every PR (reviewable output), `apply` runs only on merge to main.

No engineer should run `terraform apply` from their laptop against a shared environment. Ever.

---

## Part 4: Drift detection — quick map

See `04-tf-drift.md` for the full breakdown.

**Drift = reality != state.** Causes: manual console changes, expired resources, partial applies, third-party automation.

Detection: `terraform plan` shows drift. Automated detection: scheduled plan in CI, alert if plan output is non-empty.

---

## Key numbers to frame Terraform at Winamax scale

- 700+ microservices → 700+ IAM roles → managed by Terraform or chaos
- Multiple environments (dev, staging, prod) → state isolation is mandatory
- 50 TB of data → RDS changes require extra caution — `prevent_destroy = true`
- Kafka at 75k msg/sec → MSK config changes are not zero-risk operations

The discipline (plan, review, apply, never skip) matters more at this scale than in a 5-service startup.
