# Security Groups vs NACLs — Deep Dive

## The core distinction: stateful vs stateless

This is the single most important thing to understand, and the most common interview question.

**Security Groups are stateful.** When you allow inbound traffic on port 443, the return traffic (from your server back to the client) is automatically allowed — AWS tracks the connection state. You write one rule.

**NACLs (Network Access Control Lists) are stateless.** AWS does not track connection state. If you allow inbound TCP on port 443, you must also explicitly allow outbound TCP on the ephemeral port range (1024–65535) for the client to receive the response. You write two rules per direction.

---

## Security Groups in depth

A Security Group is attached to an **ENI (Elastic Network Interface)** — the virtual network card of your resource (ECS task, EC2 instance, RDS instance, load balancer, etc.).

### Rules

Security Group rules are **allow-only**. There is no Deny rule. If no rule matches, traffic is dropped.

```
Inbound rules (what can reach this resource):
  Type        Protocol  Port Range  Source
  HTTPS       TCP       443         0.0.0.0/0          ← allow from internet
  Custom TCP  TCP       8080        sg-abc123           ← allow from specific SG

Outbound rules (what this resource can reach):
  All traffic  All  All  0.0.0.0/0  ← default: allow all outbound
```

### Security Group as a source

You can reference another security group as the source instead of a CIDR. This means: "allow traffic from any resource that has this security group attached."

Example: ECS task SG allows inbound 8080 from ALB SG. This is more maintainable than hardcoding IP ranges — as ALB IPs change, the rule stays valid.

```
ECS task security group inbound:
  Port 8080  source: sg-alb-prod   ← only ALB can reach the app port

RDS security group inbound:
  Port 5432  source: sg-ecs-prod   ← only ECS tasks can reach the database
```

This is the standard production pattern. Use SG-to-SG references everywhere.

### Chaining

Multiple security groups can be attached to one ENI (up to 5). All their rules are unioned — traffic is allowed if any attached SG permits it.

---

## NACLs in depth

A NACL is attached to a **subnet**. Every resource in the subnet is subject to the NACL — you cannot opt out.

### Rules

NACLs have numbered rules evaluated in ascending order. First match wins.

```
Inbound rules:
  Rule #  Type        Protocol  Port Range  Source          Allow/Deny
  100     HTTPS       TCP       443         0.0.0.0/0       ALLOW
  200     HTTP        TCP       80          0.0.0.0/0       ALLOW
  *       All traffic All       All         0.0.0.0/0       DENY   ← default deny

Outbound rules:
  Rule #  Type        Protocol  Port Range  Destination     Allow/Deny
  100     Custom TCP  TCP       1024-65535  0.0.0.0/0       ALLOW  ← ephemeral ports!
  *       All traffic All       All         0.0.0.0/0       DENY
```

The `*` rule (default deny) always has the highest number and cannot be deleted.

### The ephemeral port problem

When a client connects to your server on port 443, the client's OS picks a random source port from the ephemeral range (1024–65535) for the return path. Because NACLs are stateless, you must explicitly allow outbound traffic on that entire range. If you don't, return packets are dropped.

This is a common misconfiguration: inbound 443 is allowed, but no outbound ephemeral rule exists → connection establishes (SYN gets through) but data doesn't flow (return packets blocked).

---

## Evaluation order

When traffic hits a resource in a subnet:

1. NACL inbound rules evaluated (subnet level)
2. Security Group inbound rules evaluated (resource level)
3. Traffic reaches the resource
4. Security Group outbound rules evaluated (stateful — return traffic auto-allowed for established connections)
5. NACL outbound rules evaluated (stateless — must be explicitly allowed)

A packet is dropped if it fails at any of these steps.

---

## When to use each

| Use case | Tool |
|--|--|
| Allow specific services to talk to each other | Security Group (SG-to-SG reference) |
| Block a malicious IP range across a whole subnet | NACL explicit Deny rule |
| Default access control for all resources | Security Group |
| Compliance requirement for subnet-level controls | NACL |

**In practice:** Security Groups handle 95% of all access control. NACLs are used defensively (block a known bad CIDR) or for compliance requirements that specifically require subnet-level controls.

---

## Common interview scenario: connectivity debug

**"An ECS task can't connect to RDS on port 5432. Where do you look?"**

1. **ECS task SG outbound**: does it allow TCP 5432 to the RDS SG or CIDR?
2. **RDS SG inbound**: does it allow TCP 5432 from the ECS task SG?
3. **NACL on ECS task subnet outbound**: does it allow TCP 5432?
4. **NACL on RDS subnet inbound**: does it allow TCP 5432?
5. **NACL on RDS subnet outbound**: does it allow the ephemeral port range (1024–65535) back to the ECS subnet?
6. **NACL on ECS subnet inbound**: same ephemeral port range?
7. Route tables: are both subnets in the same VPC? Is there a route?

Security Groups are stateful so you only need to allow one direction per SG. NACLs require both directions.

**K8s bridge:** Kubernetes NetworkPolicy is like Security Groups — allow-only, applied at the pod level, evaluated per-connection. There is no direct Kubernetes equivalent to NACLs. This is one area where AWS gives you an additional control layer.
