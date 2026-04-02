# Terraform Module Design: When to Abstract, When to Stay Flat

## What a module is

A Terraform module is a directory of `.tf` files used as a reusable component. Every Terraform root is technically a module (the root module). A child module is a module called from another module.

```hcl
# root module calling a child module
module "bet_validator_service" {
  source = "./modules/ecs-service"   # local path

  name           = "bet-validator"
  cluster_arn    = aws_ecs_cluster.main.arn
  container_port = 8080
  cpu            = 512
  memory         = 1024
  desired_count  = 3
}
```

The module encapsulates all the ECS service resources (service, task definition, IAM role, security group, target group, listener rule) behind a clean interface.

---

## When to create a module (and when not to)

### Create a module when:

**1. The same pattern repeats across 3+ real uses**

At Winamax with 700+ microservices, "deploy an ECS service" is the same pattern repeated hundreds of times. Without a module: 700 copies of the same 150 lines of ECS resource declarations. With a module: 700 calls to `module "service_name" { source = "./modules/ecs-service" }`.

**2. The abstraction captures domain knowledge, not just syntax**

A good module enforces conventions: IAM role is always named `${var.name}-task-role`, security group always allows traffic only from the ALB, CloudWatch log group always exists. Callers cannot accidentally skip these.

**3. The module boundary matches a team or ownership boundary**

Platform team owns the VPC, networking, and cluster modules. Application teams own service modules. The interface between them is the module's variable/output contract.

### Do NOT create a module when:

**1. You have fewer than 3 real uses**

A module with one caller is overhead with no benefit. Write it flat. If a second and third caller appear, extract the module then.

**2. The module just wraps a single resource**

```hcl
# This is pointless — just use the resource directly
module "s3_bucket" {
  source      = "./modules/s3-bucket"
  bucket_name = "my-bucket"
}
```

A module that is a 1:1 wrapper around a resource adds indirection without abstraction.

**3. The abstraction forces callers to fight it**

If callers routinely pass `override_*` variables or use `depends_on` to work around module behavior, the module interface is wrong. Better to go flat and understand the actual requirements first.

---

## Module structure

```
modules/
└── ecs-service/
    ├── main.tf         # resource declarations
    ├── variables.tf    # input variables (the interface)
    ├── outputs.tf      # output values
    └── versions.tf     # required providers and terraform version
```

### variables.tf — design the interface carefully

```hcl
variable "name" {
  type        = string
  description = "Service name. Used as prefix for all resource names."
}

variable "cluster_arn" {
  type        = string
  description = "ARN of the ECS cluster to run the service in."
}

variable "container_port" {
  type        = number
  description = "Port the container listens on."
  default     = 8080
}

variable "desired_count" {
  type        = number
  description = "Desired number of running tasks."
  default     = 2
}

variable "cpu" {
  type        = number
  description = "CPU units (256, 512, 1024, 2048, 4096)."
  default     = 256
  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "CPU must be a valid Fargate CPU value."
  }
}

variable "environment_variables" {
  type        = map(string)
  description = "Environment variables injected into the container."
  default     = {}
}

variable "tags" {
  type        = map(string)
  description = "Additional tags to apply to all resources."
  default     = {}
}
```

Good module variables:
- Have clear descriptions (they appear in `terraform plan` output)
- Have sensible defaults for optional config
- Validate where the set of valid values is bounded (CPU units, environment names)
- Accept `tags` as a passthrough — callers always have org-specific tags to add

### outputs.tf

```hcl
output "service_arn" {
  description = "ARN of the ECS service."
  value       = aws_ecs_service.this.id
}

output "task_role_arn" {
  description = "ARN of the IAM task role — use to grant additional permissions."
  value       = aws_iam_role.task.arn
}

output "security_group_id" {
  description = "ID of the service security group — use to allow access from other services."
  value       = aws_security_group.this.id
}
```

Expose what callers will reasonably need. The task role ARN and security group ID are frequently needed to grant the service access to downstream resources.

---

## Module versioning

For modules shared across teams, use versioned sources rather than local paths:

```hcl
# From a Git tag
module "ecs_service" {
  source = "git::https://github.com/winamax/terraform-modules.git//ecs-service?ref=v2.3.0"
}

# From Terraform Registry (public or private)
module "ecs_service" {
  source  = "winamax/ecs-service/aws"
  version = "~> 2.3"
}
```

Pinning to a Git tag means: platform team cuts `v2.4.0` with a new feature. Application teams choose when to upgrade. No one is surprised by a module change they did not request.

---

## Flat vs modular: practical decision tree

```
Is this pattern used in 3+ places?
├── No  → stay flat
└── Yes → Does the abstraction simplify callers (fewer decisions to make)?
          ├── No  → stay flat, the module would be leaky
          └── Yes → Does it need versioning (shared across teams)?
                    ├── No  → local module in ./modules/
                    └── Yes → separate repo with versioned releases
```

---

## Anti-patterns to name in an interview

**1. The mega-module:** One module that creates everything for a service — VPC, cluster, service, database, IAM, monitoring. Plan output is 200 resources. Blast radius is enormous. One error blocks all changes.

**2. Module-ception:** Module A calls module B calls module C. Three levels of indirection to create one S3 bucket. Debug a plan error — you are reading variables passed through three levels. Stay flat unless the abstraction earns its complexity.

**3. Hard-coded module:** Module has environment-specific logic baked in with `if var.environment == "prod"` throughout. Now every environment change touches the module, triggering a plan across all callers.

**4. No outputs:** Module creates resources but exposes no outputs. Callers have to use data sources to look up resources by name instead of consuming the ID directly. This creates implicit coupling that Terraform cannot model as a dependency.
