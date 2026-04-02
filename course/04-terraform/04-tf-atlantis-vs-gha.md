# Atlantis vs GitHub Actions for Terraform: Trade-offs

## What each is

### GitHub Actions
A general-purpose CI/CD system built into GitHub. Terraform workflows are YAML files that run `terraform plan` and `terraform apply` as shell commands, triggered by PR events and push events.

### Atlantis
A dedicated open-source tool built specifically for Terraform CI/CD. It runs as a server in your infrastructure. When you open a PR, Atlantis automatically runs `terraform plan` and posts the output as a comment. You approve the plan by commenting `atlantis apply` on the PR. Atlantis runs `terraform apply` in response.

---

## Side-by-side comparison

| Dimension | GitHub Actions | Atlantis |
|-----------|---------------|----------|
| **What it is** | General CI/CD, Terraform via shell | Terraform-specific GitOps server |
| **Where it runs** | GitHub infrastructure (SaaS) | Your infrastructure (self-hosted server) |
| **Plan trigger** | PR open / push (workflow event) | PR open (automatic) |
| **Apply trigger** | Push to main (workflow) | `atlantis apply` PR comment |
| **Plan/apply lock** | Managed by Terraform state lock (DynamoDB) | Atlantis holds its own lock — one PR applies at a time |
| **Plan output location** | PR comment (via GitHub Actions script) | PR comment (built-in) |
| **Audit trail** | GitHub Actions run logs | PR comment history + Atlantis logs |
| **Setup complexity** | Moderate (write the YAML workflow) | Higher (deploy and maintain the Atlantis server) |
| **Maintenance burden** | Low (GitHub manages the runner infrastructure) | Medium (Atlantis server upgrades, HA, monitoring) |
| **AWS credential management** | OIDC (short-lived, no secrets) | Long-lived credentials OR OIDC to Atlantis server role |
| **Multi-root support** | Matrix strategy per root | Native — Atlantis auto-detects changed roots |
| **Cost** | GitHub Actions minutes (free tier then paid) | EC2/Fargate for the server + your time to maintain |
| **Best fit** | Teams already on GitHub, moderate Terraform scale | Large Terraform footprints, complex workspace workflows |

---

## GitHub Actions: strengths and weaknesses

### Strengths

**No server to maintain:** GitHub runs the workflow. No EC2 instance, no uptime concern, no server patching.

**OIDC authentication:** Cleanest credential model — short-lived tokens, no long-lived keys stored anywhere.

**Flexibility:** Any CI/CD logic you need (conditional applies, notifications, post-apply smoke tests) is one more step in the YAML.

**Already there:** If you are using GitHub, Actions is zero additional infrastructure.

### Weaknesses

**Locking:** GitHub Actions does not have native plan-to-apply locking. If you plan on PR and apply on merge, someone can merge before you review the plan. The plan may be stale by apply time. Mitigation: save and use plan files (see `04-tf-cicd.md`).

**PR comment management:** Posting plan output to PRs requires a custom script step. The output can get long (hundreds of resources). Not as polished as Atlantis out of the box.

**Multi-root complexity:** With 700+ Terraform roots, detecting which roots changed on a PR and running plans for only those is non-trivial. Requires extra tooling (e.g., `terraform-changed-modules`) or a matrix strategy that plans all roots on every PR (slow).

---

## Atlantis: strengths and weaknesses

### Strengths

**PR-comment workflow is native:** `atlantis plan`, `atlantis apply` — everyone on the team uses the same UX without configuring anything.

**Native locking:** Atlantis prevents two PRs from applying the same root simultaneously. While PR A is applying, PR B that touches the same root is blocked. This is stronger than DynamoDB state locking alone (which only prevents concurrent applies, not concurrent planning).

**Auto-detect changed roots:** Atlantis reads a configuration file (`atlantis.yaml`) that defines your Terraform roots. On a PR, it automatically identifies which roots have changed and runs plans for only those.

**Self-contained workflow:** Plan output → comment → `atlantis apply` → done. No GitHub workflow YAML to maintain.

### Weaknesses

**You must run and maintain the Atlantis server:**
- It is a stateful service (holds workflow state between PR events)
- Needs to be highly available (if it is down, no Terraform changes can merge)
- Needs to be updated when Atlantis releases new versions
- Needs network access to GitHub webhooks + AWS APIs

**Long-lived AWS credentials (traditionally):** Atlantis assumes IAM roles. Historically this meant long-lived IAM keys stored as environment variables on the server. Modern Atlantis + EC2 instance role or ECS task role resolves this, but it is more complex than GitHub OIDC.

**Webhook dependency:** Atlantis receives GitHub webhooks. If your network has strict egress controls or GitHub webhook delivery fails, Atlantis does not know about PR events.

---

## The recommendation for Winamax

Winamax likely uses GitHub Actions or GitLab CI for their general CI/CD. For a platform team with ~700+ Terraform roots, the argument goes:

**Use GitHub Actions if:**
- You are starting fresh and want minimal infrastructure to maintain
- The Terraform footprint is moderate (under 50-100 roots)
- Team is already comfortable with GitHub Actions YAML

**Use Atlantis if:**
- You have a large number of roots and need automatic changed-root detection
- The PR-comment workflow (`atlantis apply`) is a strong team preference
- You want plan-to-apply locking that GitHub Actions does not provide natively
- You have the operational capacity to run a reliable Atlantis server

**What to say in an interview:**

> "For Winamax's scale, I would start with GitHub Actions — OIDC authentication to AWS, plan on PR as a comment, apply on merge with a saved plan file. The setup is simpler and there is no server to maintain. If the team grows to a scale where managing hundreds of roots becomes friction — detecting which roots changed, preventing concurrent applies across PRs — I would evaluate Atlantis. The trade-off is that Atlantis is a server you operate, which adds reliability and maintenance overhead.
>
> The most important principle is not the tool: it is that every apply goes through a reviewed plan, no one applies from their laptop, and AWS credentials are never stored long-lived in CI."

---

## Atlantis configuration file

For context — this is what `atlantis.yaml` looks like for multi-root setups:

```yaml
# atlantis.yaml — at repo root
version: 3
projects:
  - name: prod-vpc
    dir: infra/prod/vpc
    workspace: default
    apply_requirements: [approved, mergeable]  # PR must be approved before apply

  - name: prod-ecs-cluster
    dir: infra/prod/ecs-cluster
    workspace: default
    apply_requirements: [approved, mergeable]
    depends_on: [prod-vpc]   # apply VPC before cluster

  - name: prod-bet-validator
    dir: infra/prod/services/bet-validator
    workspace: default
    apply_requirements: [approved, mergeable]
    depends_on: [prod-ecs-cluster]
```

Atlantis auto-detects which projects have changed files on a PR and runs only those plans.
