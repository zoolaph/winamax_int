# Module 5 — AWS Core: Networking, IAM, and Foundational Services

**Priority: HIGH — Everything else runs on top of this. You cannot fake it.**

AWS networking and IAM underpin every other topic. A candidate who cannot reason about VPCs, security groups, and IAM policies will fail even good answers on ECS or Terraform. This is infrastructure fundamentals — they will probe this.

---

## How to use this module

Each topic below has its own deep-dive file. The main file (this one) gives you the "one thing to keep sharp" for each topic — the mental model you carry into the interview. The deep-dive files have the operational depth.

---

## Part 1: VPC — Networking Fundamentals

See `05-vpc-deep.md` for the full guide — subnet math, route tables, IGW, NAT Gateway, VPC peering, endpoints, and the Winamax multi-AZ model.

**The one thing to keep sharp here — a VPC is a routing boundary, not a security boundary:**

- Subnets are just CIDR blocks inside a VPC. What makes a subnet "public" is that its route table has a route to an Internet Gateway (`0.0.0.0/0 → igw-xxx`). Remove that route and the subnet becomes private.
- Private subnets use a NAT Gateway (in a public subnet) to reach the internet outbound — no inbound access is possible via NAT.
- Security Groups are what actually enforce access control. A resource in a "private" subnet with a permissive SG is not private in any meaningful security sense.

**K8s bridge:** A VPC is to AWS what a Kubernetes cluster network is to pods. The route table is the CNI plugin. The NAT Gateway is like your cluster egress node. The Internet Gateway is the external LoadBalancer service type.

---

## Part 2: Security Groups vs NACLs

See `05-security-groups-nacls-deep.md` for the full guide — stateful vs stateless mechanics, rule evaluation, common patterns, and how they interact.

**The one thing to keep sharp here — stateful vs stateless is the core:**

- **Security Groups are stateful**: if you allow inbound on port 443, the return traffic is automatically allowed. You only write one rule.
- **NACLs are stateless**: you must explicitly allow both inbound AND outbound. Ephemeral ports (1024–65535) must be allowed outbound for any inbound traffic to get a response back.
- NACLs apply at the subnet level, SGs apply at the ENI (resource) level. In practice: SGs are your day-to-day control, NACLs are a subnet-wide blunt instrument for blocking a bad CIDR range.

**K8s bridge:** Security Groups are like Kubernetes NetworkPolicy but enforced by AWS hardware — no CNI plugin required. NACLs are like node-level iptables rules applied before pod-level NetworkPolicy.

---

## Part 3: Load Balancing — ALB vs NLB

See `05-load-balancing-deep.md` for the full guide — target group mechanics, listener rules, health check tuning, sticky sessions, and the ECS integration pattern.

**The one thing to keep sharp here — layer 4 vs layer 7:**

- **ALB (Application Load Balancer)** — Layer 7. Understands HTTP/HTTPS. Routes based on path, hostname, headers, query params. Terminates TLS. Integrates with ECS natively via target groups. Use this for microservices, APIs, and anything HTTP-based.
- **NLB (Network Load Balancer)** — Layer 4. Routes TCP/UDP by IP and port only. No HTTP awareness. Ultra-low latency, preserves source IP, handles millions of connections per second. Use this for non-HTTP protocols (WebSocket at extreme scale, database proxies, gRPC that needs source IP).

**Winamax context:** Their 700+ microservices almost certainly use ALB as the default. NLB would appear for WebSocket streaming (live odds) or any protocol that ALB cannot handle.

---

## Part 4: Route 53

See `05-route53-deep.md` for the full guide — record types, routing policies, health checks, failover configuration, and private hosted zones.

**The one thing to keep sharp here — routing policies are not just DNS round-robin:**

- **Simple** — one record, one target. No health checks.
- **Weighted** — split traffic by percentage. Use for canary/blue-green at DNS level.
- **Latency-based** — sends users to the region with the lowest latency. Multi-region.
- **Failover** — primary/secondary. If the primary health check fails, Route 53 returns the secondary. This is disaster recovery at the DNS layer.
- **Geolocation** — route by user's country/continent. Regulatory compliance use case.
- Health checks are separate resources — you attach them to records. They poll HTTP/TCP endpoints.

---

## Part 5: CloudFront

See `05-cloudfront-deep.md` for the full guide — origins, behaviors, cache policies, invalidation, Lambda@Edge, and the Winamax use case.

**The one thing to keep sharp here — CloudFront is not just a CDN for static files:**

- CloudFront sits in front of an origin (ALB, S3, any HTTP endpoint). It caches responses at edge locations globally — content is served from the PoP closest to the user.
- Cache behavior is controlled by cache policies (what gets cached) and origin request policies (what headers/cookies are forwarded to the origin).
- For Winamax: static frontend assets (JS, CSS) are obviously cacheable. Live odds feeds are not — they would use CloudFront with very short TTLs or bypass the cache for the odds API path while still benefiting from the edge network for connection speed.

---

## Part 6: IAM

See `05-iam-deep.md` for the full guide — policy evaluation logic, trust policies, instance profiles, assume role, service-linked roles, permission boundaries, and the ECS dual-role model.

**The one thing to keep sharp here — there are three things that must all be true for an action to be allowed:**

1. The **identity policy** (attached to user/role) must allow the action.
2. The **resource policy** (on the bucket/queue/etc.) must allow — or at least not explicitly deny — the action.
3. There must be no **explicit Deny** anywhere. Explicit Deny always wins.

**The ECS dual-role pattern (from Module 1) is the most important IAM interview question:**
- `executionRoleArn` — ECS agent uses this. Pull image, fetch secrets, write logs.
- `taskRoleArn` — application uses this at runtime. Call S3, SQS, DynamoDB.

**K8s bridge:** IAM roles assumed by ECS tasks are exactly analogous to Kubernetes ServiceAccounts with IRSA (IAM Roles for Service Accounts). The trust policy is the binding between the workload identity and the AWS role.

---

## Part 7: S3

See `05-s3-deep.md` for the full guide — bucket policies, ACLs, lifecycle rules, versioning, storage classes, event notifications, and use as a trace/log backend.

**The one thing to keep sharp here — S3 as infrastructure, not just file storage:**

- Winamax uses S3 as the object store for Quickwit (their log search engine). Logs are written to S3, Quickwit indexes them.
- Storage classes + lifecycle rules are the cost lever: logs that are never queried after 90 days go to S3 Glacier, cutting storage cost by 80%.
- Bucket policies and IAM together control access. Block Public Access is a separate account-level guardrail that overrides even permissive policies.

---

## Part 8: CloudWatch

See `05-cloudwatch-deep.md` for the full guide — log groups, metric filters, alarms, dashboards, Container Insights, and the reasoning behind moving to Prometheus+Grafana.

**The one thing to keep sharp here — why Winamax moved away from CloudWatch for metrics:**

CloudWatch is serviceable but has limits at Winamax's scale:
- Custom metrics are expensive per-metric at high cardinality.
- Prometheus + Grafana gives richer querying (PromQL vs CloudWatch math expressions), better dashboards, and no per-metric cost.
- CloudWatch Logs still has a role: ECS container logs are shipped to CloudWatch Logs by default via the `awslogs` driver, and that is fine for basic tail/grep. Quickwit is the serious log query layer on top.

You should still know CloudWatch well — it is the default and many alarms (billing, EC2 status, ALB 5xx rate) still live there.

---

## Part 9: Secrets Manager vs SSM Parameter Store

See `05-secrets-deep.md` for the full guide — use cases, rotation, cross-account, cost, ECS integration patterns.

**The one thing to keep sharp here — when to use which:**

| | Secrets Manager | SSM Parameter Store |
|--|--|--|
| Primary use | Database passwords, API keys, credentials | Config values, feature flags, non-secret params |
| Rotation | Built-in automatic rotation (Lambda-based) | Manual only |
| Cost | ~$0.40/secret/month + API call cost | Free tier (Standard); $0.05/param/month (Advanced) |
| ECS integration | Injected as env vars via `secrets` in task def | Same — `valueFrom` points to SSM path |
| Cross-account | Native support | Possible but complex |

**Decision rule:** If the value is a credential that should rotate automatically, use Secrets Manager. Everything else — config, URLs, feature flags — use SSM Parameter Store with SecureString for anything sensitive.

---

## Exercises

`exercises/05-aws-core/` — hands-on labs:
- `01-vpc-design.md` — design the Winamax VPC layout
- `02-iam-policy-debug.md` — fix broken IAM policies
- `03-alb-routing.md` — ALB listener rules for microservices
- `04-incident-sg.md` — diagnose a connectivity failure using SGs

## Interview Q&A

`interview/05-aws-questions.md`
