# Wargame 05 — Terraform Plan Shows -/+ on Aurora Instance

## The scenario

You are reviewing a PR that updates the `prod/rds` Terraform root. A colleague changed the Aurora cluster's parameter group from `default.aurora-mysql8.0` to a custom `winamax-aurora-mysql8.0` parameter group. The PR looks clean. You run the plan in CI to review it.

The plan output is:

```
Terraform will perform the following actions:

  # aws_rds_cluster.main must be replaced
-/+ resource "aws_rds_cluster" "main" {
      ~ cluster_parameter_group_name = "default.aurora-mysql8.0" -> "winamax-aurora-mysql8.0" # forces replacement
        id                           = "winamax-prod-aurora"
        ...
    }

Plan: 1 to add, 0 to change, 1 to destroy.
```

The database is `winamax-prod-aurora`. It holds 50 TB of betting data. It has been running in production for 3 years.

---

## Your job

1. What does `-/+` mean exactly? What will happen if you approve and merge this PR?
2. What is your immediate response to this plan?
3. How do you achieve the intended change (switching parameter groups) without replacing the database?
4. What safeguards should already be in place that would prevent this from being applied even if someone approved it?

**Answer all four before reading on.**

---
---
---
---
---
---

## Diagnosis path

### What `-/+` means

`-/+` is destroy and recreate. Terraform will:
1. Create a new Aurora cluster with the new parameter group
2. Destroy the existing `winamax-prod-aurora` cluster

The new cluster will be empty. 50 TB of betting data will be destroyed. This is not a backup/restore — it is a deletion followed by a fresh cluster creation.

**Do not approve this PR. Do not merge. Do not apply.**

### Why is parameter group change forcing replacement?

Some AWS resource attributes, when changed, cannot be updated in-place — AWS requires destroying and recreating the resource. For RDS/Aurora clusters, changing the `cluster_parameter_group_name` is one of these attributes for certain parameter group types.

However: **this is almost certainly wrong behavior**. Parameter groups can be changed on a live Aurora cluster without replacement — it is a modify operation, not a recreate. The forced replacement is likely caused by:

1. **The parameter group does not exist yet** — Terraform cannot find `winamax-aurora-mysql8.0` and treats the change as requiring replacement
2. **The Terraform AWS provider version has a bug** — some older provider versions incorrectly mark this as `ForceNew`
3. **The parameter group family does not match** — the custom parameter group was created with a different family (e.g., `aurora-mysql5.7` instead of `aurora-mysql8.0`)

### Step 1 — Identify the real cause of the forced replacement

```bash
# Does the parameter group exist?
aws rds describe-db-cluster-parameter-groups \
  --db-cluster-parameter-group-name winamax-aurora-mysql8.0

# What family is it?
aws rds describe-db-cluster-parameter-groups \
  --db-cluster-parameter-group-name winamax-aurora-mysql8.0 \
  --query 'DBClusterParameterGroups[0].DBParameterGroupFamily'
```

If it does not exist: the Terraform code that creates it is in a different root or missing entirely. The plan is trying to change a reference to something that does not exist.

If the family is wrong: the parameter group cannot be applied to this Aurora version.

### Step 2 — The correct path for changing an Aurora parameter group

Changing an Aurora cluster's parameter group is an in-place modify operation on AWS. If the Terraform provider is forcing replacement, you need to either:

**Option A: Use `aws_rds_cluster` `apply_immediately = false` with a plan that shows `~` (modify), not `-/+`**

Verify the parameter group exists and has the correct family before changing the reference in Terraform. With the right setup, Terraform should show:

```
~ aws_rds_cluster.main {
    ~ cluster_parameter_group_name = "default.aurora-mysql8.0" -> "winamax-aurora-mysql8.0"
  }
```

No replacement. In-place modify.

**Option B: Change the parameter group outside Terraform first, then import**

```bash
aws rds modify-db-cluster \
  --db-cluster-identifier winamax-prod-aurora \
  --db-cluster-parameter-group-name winamax-aurora-mysql8.0 \
  --apply-immediately
```

Then update the Terraform `.tf` file to match. Run `terraform plan` — it should show no changes (or only a pending reboot if the parameter group requires it).

### Step 3 — Safeguards that should catch this

**`prevent_destroy = true` in lifecycle:**

```hcl
resource "aws_rds_cluster" "main" {
  # ...
  lifecycle {
    prevent_destroy = true
  }
}
```

With `prevent_destroy = true`, running `terraform plan` with a `-/+` on this resource produces an error:

```
Error: Instance cannot be destroyed
  on main.tf line 5, in resource "aws_rds_cluster" "main":
  resource "aws_rds_cluster" "main" {
  
  This resource is configured with lifecycle.prevent_destroy = true.
  A plan that would destroy this resource has been generated. 
  To proceed, you must first remove this protection.
```

The plan would never reach a reviewable state. CI would fail.

**`deletion_protection = true` on the cluster:**

```hcl
resource "aws_rds_cluster" "main" {
  deletion_protection = true
}
```

Even if someone removed `prevent_destroy` and applied the plan, AWS would reject the delete operation:

```
Error: error deleting RDS Cluster: InvalidParameterCombination: 
Cannot delete protected Cluster, please disable deletion protection and try again.
```

**Both protections should be set on every production database.** The combination means: Terraform won't plan it, and AWS won't allow it even if the plan somehow runs.

### The answer you give in the interview

> "I see -/+ on an Aurora cluster. I immediately stop. I do not approve, I do not merge. -/+ means destroy and recreate — that is 50 TB of data deleted.
>
> My first question is why Terraform thinks a parameter group change requires replacement. That should be an in-place modify. I check whether the parameter group actually exists and has the correct family. Almost always the replacement is caused by the parameter group being missing or misconfigured, not by an inherent AWS constraint.
>
> The fix is to create the parameter group correctly first, then make the reference change. With the right setup the plan should show ~ not -/+.
>
> The deeper issue is that this should have been caught before reaching PR review. `prevent_destroy = true` on the cluster resource would have made the plan fail in CI. `deletion_protection = true` on the AWS side would block the operation even if the plan ran. Both should be standard for any production database — if they're not set, I add them before continuing."

---

## Follow-up questions they will ask

**"Deletion protection is enabled. What happens when you legitimately need to delete the database — say, decommissioning a service?"**

You must explicitly remove the deletion_protection attribute first (set to `false`, apply), then remove the resource from Terraform (apply again to destroy). And remove `prevent_destroy` from the lifecycle block. This deliberate two-step process is the point — it forces conscious intent. You cannot accidentally destroy a database in a routine apply.

**"A colleague says 'let's just use terraform taint to mark it for recreation and it'll come back clean'. What do you say?"**

`terraform taint` marks a resource for recreation on the next apply — it is the equivalent of forcing the `-/+`. I would say no. Tainting a production database means destroying it, which means data loss. If the intention is to recreate the cluster with a new configuration, the correct approach is a migration plan: snapshot, recreate from snapshot, verify, cutover. Not a blind taint-and-apply.
