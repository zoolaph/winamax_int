# Exercise 4 — Connectivity Incident: Security Group Diagnosis

## Scenario

**Incident:** 14:32 — Alerts fire: payment service is returning 502 Bad Gateway from the ALB. The betting API depends on the payment service. Bets are failing.

**Context:**
- Payment service: ECS tasks in `sg-payments-ecs` running in private subnet, port 8080
- ALB for payments: `sg-payments-alb`, public-facing
- Payment service calls an external payment processor API (HTTPS, external internet)
- Payment service reads from RDS PostgreSQL (`sg-payments-rds`), port 5432
- Deployment happened 10 minutes ago (new container image)

**Your job:** Diagnose the 502 systematically.

---

## Task 1: First hypothesis

A 502 from ALB means the ALB cannot get a valid response from its targets.

List the 3 most likely causes in order of probability given that a deployment just happened:

1. ?
2. ?
3. ?

---

## Task 2: Check the security groups

You pull up the current security group rules. Find the bug:

**sg-payments-alb (ALB security group):**
```
Inbound:
  TCP 443  0.0.0.0/0   ALLOW
  TCP 80   0.0.0.0/0   ALLOW

Outbound:
  TCP 8080  sg-payments-ecs  ALLOW
```

**sg-payments-ecs (ECS task security group):**
```
Inbound:
  TCP 8080  sg-payments-alb  ALLOW

Outbound:
  TCP 5432  sg-payments-rds  ALLOW
  TCP 443   sg-payments-rds  ALLOW   ← someone accidentally picked the wrong SG
```

**sg-payments-rds (RDS security group):**
```
Inbound:
  TCP 5432  sg-payments-ecs  ALLOW
```

---

## Task 3: The real broken rule

After fixing the typo above, 502s continue. You check CloudWatch Logs for the payment service container and see:

```
2026-04-01 14:32:11 ERROR Failed to connect to payment-processor.example.com:443
  Connect timeout after 5000ms
2026-04-01 14:32:12 ERROR Failed to connect to payment-processor.example.com:443
```

Describe:
1. What is the root cause?
2. What do you check in the security group?
3. What do you check in the VPC/routing layer?
4. Write the missing security group rule.

---

## Task 4: Post-incident

After fixing both issues, you want to prevent this class of problem. Propose:
1. A monitoring/alerting improvement
2. A process improvement for deployments
3. A security group design change

---

## Answer Key

### Task 1: First hypotheses

1. **New container is crashing on startup** — the deployment introduced a bug; the ECS health check passes (container starts) but the app crashes when it tries to connect somewhere (database, external API). ALB sees no healthy targets → 502.

2. **Security group changed as part of the deployment pipeline** — Terraform might have applied an SG change that broke connectivity.

3. **The new image has a misconfigured environment variable** — wrong database URL, wrong API key, causing connection failures.

Why deployment-related causes first? The timing (10 minutes after deploy) is the most specific signal. Start there.

### Task 2: The bug in sg-payments-ecs

```
Outbound:
  TCP 443   sg-payments-rds  ALLOW   ← WRONG — this allows HTTPS to the RDS SG
```

This rule is incorrect — it references `sg-payments-rds` as the destination for HTTPS, but the external payment processor is on the internet, not inside RDS's security group. This rule is both wrong and harmless (it doesn't break anything because the actual outbound rule the app needs is missing — see Task 3).

Fix: delete this rule. It serves no purpose.

### Task 3: Root cause — no outbound internet access

**Root cause:** The payment service ECS tasks cannot reach the external payment processor (`payment-processor.example.com:443`) because there is no outbound rule allowing HTTPS to the internet.

1. **Security group check:** `sg-payments-ecs` outbound rules. There should be:
   ```
   TCP 443  0.0.0.0/0  ALLOW
   ```
   Currently missing — the only outbound 443 rule was the wrong one pointing to `sg-payments-rds`.

2. **VPC/routing layer check:**
   - Does the private subnet have a route to a NAT Gateway? (`0.0.0.0/0 → nat-gw`)
   - Is the NAT Gateway in a healthy state? (check NAT GW status in console)
   - Is there a VPC Endpoint for HTTPS that might be intercepting traffic? (unlikely for external endpoints, but check)

3. Missing rule:
   ```
   sg-payments-ecs Outbound:
     TCP 443   0.0.0.0/0   ALLOW   ← allow HTTPS to internet (payment processor)
     TCP 5432  sg-payments-rds  ALLOW   ← keep existing DB rule
   ```

### Task 4: Post-incident improvements

1. **Monitoring:** 
   - Add a CloudWatch Alarm on `ALB HealthyHostCount < 1` for the payments target group — alert before 502s start. Currently you find out via 502s.
   - Add synthetic monitoring: a canary (CloudWatch Synthetics or external) that makes a test payment API call every minute. Alerts within 1 minute of a break.

2. **Process:**
   - Add connectivity smoke test to the deployment pipeline. Before marking a deployment complete, verify: ECS task can reach RDS (TCP connect to port 5432), ECS task can reach external payment processor (HTTPS probe).
   - Terraform plan review for security group changes should require a second approval.

3. **Security group design:**
   - Use **named constants** for well-known ports in Terraform variables (`var.pg_port = 5432`, `var.https_port = 443`). Reduces copy-paste errors.
   - Separate the "internal" and "external" outbound rules into clearly named rules with descriptions. Terraform supports `description` on SG rules — use it:
     ```hcl
     egress {
       description     = "PostgreSQL to RDS"
       from_port       = 5432
       to_port         = 5432
       protocol        = "tcp"
       security_groups = [aws_security_group.rds.id]
     }
     egress {
       description = "HTTPS to external payment processor"
       from_port   = 443
       to_port     = 443
       protocol    = "tcp"
       cidr_blocks = ["0.0.0.0/0"]
     }
     ```
