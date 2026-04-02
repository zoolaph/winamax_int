# Exercise 1 — Design the Winamax VPC Layout

## Scenario

You are joining Winamax's SRE team. They have a single production AWS account in `eu-west-3` (Paris). They need a VPC design for their production ECS workloads.

Requirements:
- 700+ ECS tasks across multiple services (API, odds engine, payment, kafka consumers)
- RDS PostgreSQL databases (must not be reachable from the internet)
- ALBs for external-facing services (must be reachable from the internet)
- NAT Gateway for private subnet outbound access
- High availability — no single AZ can be a SPOF
- VPC Endpoints to minimize NAT Gateway traffic for ECR and S3

---

## Task 1: Design the CIDR layout

Given VPC CIDR `10.10.0.0/16`, fill in the subnet plan:

```
VPC: 10.10.0.0/16

AZ: eu-west-3a
  Public subnet:   ____________  (for: ALB, NAT GW)
  Private subnet:  ____________  (for: ECS tasks)
  DB subnet:       ____________  (for: RDS, ElastiCache)

AZ: eu-west-3b
  Public subnet:   ____________
  Private subnet:  ____________
  DB subnet:       ____________

AZ: eu-west-3c
  Public subnet:   ____________
  Private subnet:  ____________
  DB subnet:       ____________
```

Questions:
1. How many NAT Gateways do you deploy, and where?
2. What does the private subnet route table look like?
3. What does the public subnet route table look like?

---

## Task 2: Route table configuration

Write the route tables for:

**Public subnet (eu-west-3a):**
```
Destination    Target
___________    ______
___________    ______
```

**Private subnet (eu-west-3a):**
```
Destination    Target
___________    ______
___________    ______
```

---

## Task 3: Security Group design

Design security groups for these resources:

1. **ALB security group** (`sg-alb-prod`)
   - Inbound from: ?
   - Outbound to: ?

2. **ECS task security group** (`sg-ecs-tasks-prod`)
   - Inbound from: ?
   - Outbound to: ?

3. **RDS security group** (`sg-rds-prod`)
   - Inbound from: ?
   - Outbound to: ?

---

## Task 4: VPC Endpoints

List which VPC Endpoints you would create and why:

| Endpoint type | Service | Reason |
|--|--|--|
| Interface | ??? | ??? |
| Interface | ??? | ??? |
| Gateway | ??? | ??? |
| Interface | ??? | ??? |

---

## Answer Key

### Task 1: CIDR layout

```
VPC: 10.10.0.0/16

AZ: eu-west-3a
  Public subnet:   10.10.1.0/24   → ALB nodes, NAT GW
  Private subnet:  10.10.10.0/23  → ECS tasks (512 addresses)
  DB subnet:       10.10.20.0/24  → RDS, ElastiCache

AZ: eu-west-3b
  Public subnet:   10.10.2.0/24
  Private subnet:  10.10.12.0/23
  DB subnet:       10.10.21.0/24

AZ: eu-west-3c
  Public subnet:   10.10.3.0/24
  Private subnet:  10.10.14.0/23
  DB subnet:       10.10.22.0/24
```

Private subnets use /23 (510 usable IPs) because ECS tasks at scale can consume many IPs.

1. **3 NAT Gateways** — one per AZ, deployed in the public subnet of each AZ. Each AZ's private subnet routes to its local NAT GW. If you use one NAT GW, it becomes a cross-AZ dependency and a single point of failure.

2. **Private subnet route table:**
   ```
   10.10.0.0/16   local          → intra-VPC
   0.0.0.0/0      nat-gw-3a      → outbound internet via NAT GW in same AZ
   ```

3. **Public subnet route table:**
   ```
   10.10.0.0/16   local
   0.0.0.0/0      igw-prod       → internet
   ```

### Task 3: Security Groups

1. **ALB SG (`sg-alb-prod`)**
   - Inbound: TCP 443 from 0.0.0.0/0 (internet HTTPS), TCP 80 from 0.0.0.0/0 (redirect to HTTPS)
   - Outbound: TCP 8080 to sg-ecs-tasks-prod (forward to ECS tasks)

2. **ECS task SG (`sg-ecs-tasks-prod`)**
   - Inbound: TCP 8080 from sg-alb-prod (traffic from ALB only)
   - Outbound: TCP 5432 to sg-rds-prod, TCP 443 to 0.0.0.0/0 (for AWS API calls, ECR pull), TCP 9092 to MSK SG

3. **RDS SG (`sg-rds-prod`)**
   - Inbound: TCP 5432 from sg-ecs-tasks-prod
   - Outbound: none needed (RDS initiates no outbound connections)

### Task 4: VPC Endpoints

| Endpoint type | Service | Reason |
|--|--|--|
| Interface | ECR API (ecr.api) | ECS tasks pull image metadata — avoid NAT GW cost |
| Interface | ECR DKR (ecr.dkr) | ECS tasks pull image layers — large data, avoid NAT GW |
| Gateway | S3 | ECS agent pulls layers from S3 behind ECR; also Quickwit/log writes — free |
| Interface | Secrets Manager | ECS executionRole fetches secrets at task start — avoid NAT GW |
| Interface | CloudWatch Logs | ECS awslogs driver writes logs — avoid NAT GW |
| Interface | SSM | Parameter Store reads at task start |
