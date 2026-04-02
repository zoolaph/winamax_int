# Import and Refactoring: Bringing Existing Infrastructure Under Terraform

## The scenario

Winamax has been running since 2010. Not everything was built with Terraform from day one. Some infrastructure was created via the console, some by scripts, some by older tools. You need to bring it under Terraform management without destroying and recreating it.

The challenge: Terraform does not know these resources exist. Its state is empty. If you write a `.tf` declaration and run `terraform apply`, Terraform tries to create a new resource — which will either conflict with the existing one or run alongside it.

---

## `terraform import`: the classic approach

`terraform import` reads an existing AWS resource and writes its identity into Terraform state, linking it to a `.tf` declaration you write.

```bash
# General syntax
terraform import <resource_type>.<local_name> <provider_id>

# Examples:
terraform import aws_ecs_cluster.main winamax-prod                          # cluster name
terraform import aws_vpc.main vpc-0abc123def456789                          # VPC ID
terraform import aws_ecs_service.bet_validator winamax-prod/bet-validator   # cluster/service
terraform import aws_db_instance.main winamax-prod-postgres                 # RDS identifier
terraform import aws_iam_role.task_execution ecs-task-execution-role        # role name
terraform import aws_security_group.alb sg-0abc123def456789                 # SG ID
```

### The import workflow

1. **Find the resource ID** in the AWS console or CLI:
   ```bash
   aws ecs describe-clusters --clusters winamax-prod \
     --query 'clusters[0].clusterArn' --output text
   ```

2. **Write a matching `.tf` declaration:**
   ```hcl
   resource "aws_ecs_cluster" "main" {
     name = "winamax-prod"
     # Start minimal — add other attributes after import
   }
   ```

3. **Run import:**
   ```bash
   terraform import aws_ecs_cluster.main winamax-prod
   ```

4. **Run plan — fix differences:**
   ```bash
   terraform plan
   ```
   Plan will show differences between your `.tf` declaration and the actual resource. Add missing attributes to the `.tf` until the plan is empty (no changes).

5. **Empty plan = declaration matches reality = import complete.**

### Why you must get to an empty plan

If you import and then apply with a non-empty plan, Terraform modifies the real resource to match your `.tf`. If your `.tf` is missing `container_insights = "enabled"`, Terraform disables it on `terraform apply`. Import + apply with a wrong `.tf` = unintended production changes.

---

## Terraform 1.5+: the `import` block (declarative import)

Terraform 1.5 introduced a declarative import block that runs as part of the normal plan/apply cycle:

```hcl
# import.tf — add this temporarily during import
import {
  to = aws_ecs_cluster.main
  id = "winamax-prod"
}

import {
  to = aws_vpc.main
  id = "vpc-0abc123def456789"
}

import {
  to = aws_db_instance.main
  id = "winamax-prod-postgres"
}
```

```bash
terraform plan    # shows import operations + any diff
terraform apply   # performs imports and any resource changes
```

After import, remove the `import {}` blocks — they are one-time operations.

**Advantage over CLI import:** The import is reviewable in a PR (it is code), runs in CI with the normal plan/apply flow, and can import multiple resources in one apply.

---

## Terraform 1.5+: `generate config` (auto-write the `.tf`)

The most tedious part of import is writing the matching `.tf` declaration. Terraform 1.5+ can generate it:

```bash
# With import blocks in import.tf:
terraform plan -generate-config-out=generated.tf
```

Terraform generates a `.tf` file with all the attributes of the existing resource. You review, clean up, and use it as your declaration.

**Warning:** Generated configs include every attribute, including computed ones that you should not manage. Clean it up:
- Remove `id`, `arn`, `tags_all`, and other computed attributes Terraform manages automatically
- Add `lifecycle { ignore_changes = [...] }` for AWS-managed attributes
- Run `terraform plan` after cleanup — should be empty

---

## `moved` block: refactoring without destroy/recreate

When you rename a resource or move it into a module, Terraform sees it as "destroy old, create new" — dangerous for stateful resources. The `moved` block tells Terraform it is the same resource under a new name:

```hcl
# Old: resource "aws_ecs_cluster" "winamax_cluster" { ... }
# New: resource "aws_ecs_cluster" "main" { ... }

moved {
  from = aws_ecs_cluster.winamax_cluster
  to   = aws_ecs_cluster.main
}
```

After apply, remove the `moved` block. The real ECS cluster is untouched — only the state entry is renamed.

### Moving into a module

```hcl
# Old: resource "aws_ecs_service" "bet_validator" { ... }
# New: extracted into module "bet_validator" { source = "./modules/ecs-service" }

moved {
  from = aws_ecs_service.bet_validator
  to   = module.bet_validator.aws_ecs_service.this
}
```

---

## `removed` block: stop managing without destroying

When you want Terraform to forget a resource without deleting it:

```hcl
removed {
  from = aws_ecs_service.legacy_service

  lifecycle {
    destroy = false   # do not destroy — just remove from state
  }
}
```

After apply, the ECS service continues running. Terraform no longer manages it.

Equivalent to `terraform state rm`, but declarative and PR-reviewable.

---

## Import strategy for a large existing infrastructure

At Winamax, importing 700+ services' infrastructure is not a one-day task. Approach it incrementally:

### Phase 1: Core shared infrastructure first

Import in dependency order — you cannot import an ECS service if the VPC is not in state yet.

```
1. VPCs and subnets
2. Security groups
3. IAM roles
4. ECS clusters
5. Load balancers
6. RDS and MSK (import carefully — read-only plan before any apply)
7. Individual ECS services (one team at a time)
```

### Phase 2: Write declarations before importing

Do not import into an empty `.tf` file. Write the declaration first, run plan to see the diff, import, run plan again to confirm empty. This prevents accidentally applying destructive changes.

### Phase 3: One root at a time

Import one Terraform root, verify it, commit, move to the next. Do not import everything at once and then run plan.

### Phase 4: Treat import as a risk operation

For databases and Kafka: import the `.tf` declaration with `prevent_destroy = true` before adding to state. A plan that shows `- aws_db_instance.main` (destroy) is a crisis. Make it impossible to generate that plan.

---

## What to say in the interview

> "Import at Winamax's scale is a migration, not a one-off command. I would approach it in phases, starting with shared infrastructure (VPCs, IAM) and working down the dependency tree to individual services. For each resource: write the declaration first, run a plan to see the expected diff, import to link state, run plan again to confirm empty plan. I would use Terraform 1.5's declarative `import` blocks so the import operations are code-reviewed and run through CI rather than being console commands with no audit trail.
>
> The highest-risk imports are stateful resources — RDS instances and MSK clusters. For these, I set `prevent_destroy = true` before importing, so even if the `.tf` declaration has an error, Terraform cannot generate a plan that destroys the database."
