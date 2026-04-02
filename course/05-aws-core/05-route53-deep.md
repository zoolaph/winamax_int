# Route 53 — Deep Dive

## What Route 53 is

Route 53 is AWS's DNS service. It does three things:
1. **Domain registration** — buy and manage domain names.
2. **DNS hosting** — authoritative DNS for your domains (hosted zones).
3. **Health checking** — monitor endpoints and route traffic based on health.

---

## Hosted zones

A hosted zone is a container for DNS records for a specific domain.

- **Public hosted zone** — answers DNS queries from the internet. For `winamax.fr`, the public hosted zone holds records that any resolver can query.
- **Private hosted zone** — answers DNS queries only from within one or more VPCs. Used for internal service discovery: `api.internal.winamax.fr` resolves to an ALB or ECS task only from inside the VPC. No public exposure.

---

## Record types

| Type | Purpose | Example |
|--|--|--|
| A | Maps hostname to IPv4 address | `api.winamax.fr → 1.2.3.4` |
| AAAA | Maps hostname to IPv6 address | `api.winamax.fr → 2001:db8::1` |
| CNAME | Alias one hostname to another | `www.winamax.fr → winamax.fr` |
| Alias | AWS-specific: maps to AWS resource (ALB, CloudFront, S3) — no charge for queries, works at zone apex | `winamax.fr → alb-123.eu-west-3.elb.amazonaws.com` |
| MX | Mail exchange | Email routing |
| TXT | Arbitrary text — used for domain verification, SPF, DKIM | `"v=spf1 include:..."` |
| NS | Name server records — authoritative name servers for the zone | Auto-created by Route 53 |
| SOA | Start of Authority — zone metadata | Auto-created |

**Alias vs CNAME:** At the zone apex (`winamax.fr`, not `www.winamax.fr`), you cannot use a CNAME — DNS spec forbids it. Use an Alias record to point the apex directly to an AWS resource. Alias records also do not cost per query, unlike CNAME lookups.

---

## Routing policies

### Simple
One record, one or more values returned. No health checks. If multiple values are returned, the client picks one at random.

```
api.winamax.fr  A  1.2.3.4
```

### Weighted
Split traffic by percentage across multiple records. Used for canary releases and blue/green at DNS level.

```
api.winamax.fr  A  Weight=90  → 1.2.3.4  (stable)
api.winamax.fr  A  Weight=10  → 5.6.7.8  (canary)
```

Route 53 returns one of the two IPs based on the weights. Note: DNS caching (TTL) means traffic shift is not instant — set low TTL (60s) when doing controlled rollouts.

### Latency-based
Returns the record from the AWS region with the lowest measured network latency for the requesting user. Requires the same record to exist in multiple regions.

```
api.winamax.fr  A  Region=eu-west-3  → Paris ALB IP
api.winamax.fr  A  Region=us-east-1  → Virginia ALB IP
```

A French user → routed to Paris. An American user → routed to Virginia. Used for multi-region active-active deployments.

### Failover
Primary/secondary pair. If the primary's health check fails, Route 53 returns the secondary record.

```
api.winamax.fr  A  Routing=PRIMARY    Health-check=hc-paris   → Paris ALB
api.winamax.fr  A  Routing=SECONDARY  (no health check)       → DR site or static page
```

This is DNS-level disaster recovery. Recovery time depends on TTL + health check interval (minimum ~30s end-to-end). Not instant — compare to ALB failover which is near-immediate.

### Geolocation
Routes based on the geographic location of the DNS resolver (approximately the user's location). Used for:
- Regulatory compliance (EU users must hit EU infrastructure)
- Language-specific content (French users see French site)
- Blocking specific regions

```
api.winamax.fr  A  Location=FR  → 1.2.3.4
api.winamax.fr  A  Location=EU  → 5.6.7.8
api.winamax.fr  A  Location=Default → 9.10.11.12
```

### Geoproximity (Traffic Flow only)
Like geolocation but with a bias — you can shift the boundary to route more or less traffic to a region.

### Multivalue Answer
Returns up to 8 healthy records at random. Like Simple with multiple values, but with health checks. Not a replacement for a load balancer — clients choose among the returned IPs.

---

## Health checks

Route 53 health checks monitor endpoints globally from ~15 Route 53 health checking locations worldwide.

```
Health Check:
  Protocol: HTTPS
  Host: api.winamax.fr
  Path: /health
  Port: 443
  Request interval: 30s (standard) or 10s (fast, extra cost)
  Failure threshold: 3 consecutive failures → UNHEALTHY
  String match: optional — look for specific string in response body
```

An endpoint is considered healthy if ≥18% of health checkers report it as healthy. This prevents a single bad health checker from triggering failover.

**Calculated health checks:** combine multiple health checks with AND/OR logic. Useful for expressing "the service is healthy if both the API and the database are healthy."

---

## Private hosted zones for service discovery

For internal services in a VPC, use private hosted zones. ECS services can register DNS entries in a private hosted zone via AWS Cloud Map (which integrates with ECS Service Discovery).

```
Internal DNS (private hosted zone: internal.winamax):
  kafka.internal.winamax  → MSK broker IPs
  redis.internal.winamax  → ElastiCache cluster endpoint
  payments-api.internal.winamax → internal ALB DNS name
```

**Why not use public DNS for internal services?** Unnecessary exposure of internal topology. Also, private DNS allows you to override public records — useful in split-horizon DNS setups.

---

## Winamax context

For 700+ microservices:
- Public hosted zone for player-facing domains (`winamax.fr`, `api.winamax.fr`)
- Private hosted zone(s) for service-to-service communication
- Failover routing on critical endpoints (betting API, authentication)
- Weighted routing used during deployments to shift traffic gradually
- Health checks on all public-facing endpoints feeding into alerting

**Interview angle:** "If the Paris region has an incident, how does Route 53 help?" → Failover routing policy with health checks. When health check detects the Paris ALB is down (within ~30–90s depending on interval and threshold), Route 53 starts returning the DR endpoint. Combined with a low TTL (60s), total DNS propagation to failover is ~2 minutes.
