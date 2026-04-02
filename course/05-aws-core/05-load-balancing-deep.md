# Load Balancing — Deep Dive: ALB vs NLB

## ALB — Application Load Balancer (Layer 7)

ALB understands HTTP and HTTPS. It inspects the request — method, path, host, headers, query parameters — and routes accordingly.

### How ALB + ECS works

```
Internet
  ↓
ALB (listener: HTTPS:443)
  ↓ (listener rule matches)
Target Group (type: ip, port: 8080)
  ↓ (ALB sends to a registered IP)
ECS Task (private IP in the VPC)
```

The ALB registers **task IPs directly** (not EC2 instance IPs) when you use awsvpc networking mode. ECS registers/deregisters IPs automatically as tasks start and stop.

### Listeners

A listener is a port+protocol on the ALB. You must configure at least one.

```
Listener: HTTPS:443
  - Certificate: ACM certificate for *.winamax.fr
  - Default action: forward to target group tg-api-prod

Listener: HTTP:80
  - Default action: redirect to HTTPS:443 (permanent 301)
```

### Listener rules

Rules let you route different requests to different target groups on the same ALB. Rules are evaluated in priority order (lowest number = highest priority).

```
Priority 10: host-header is api.winamax.fr → forward to tg-api-prod
Priority 20: host-header is odds.winamax.fr AND path is /live/* → forward to tg-odds-live
Priority 30: path is /admin/* AND source-ip is 10.0.0.0/8 → forward to tg-admin
Default:     → return 404 fixed response
```

Condition types available: `host-header`, `path-pattern`, `http-header`, `http-request-method`, `query-string`, `source-ip`.

**Winamax use case:** With 700+ microservices, they likely have one ALB per environment (or per service cluster) with many listener rules routing by hostname. Path-based routing handles versioned APIs (`/v1/`, `/v2/`).

### Target groups

A target group is a pool of targets with a health check.

```
Target Group: tg-api-prod
  Target type: ip          ← required for ECS awsvpc
  Protocol: HTTP
  Port: 8080
  VPC: vpc-prod
  
  Health check:
    Protocol: HTTP
    Path: /health
    Healthy threshold: 2 consecutive successes
    Unhealthy threshold: 3 consecutive failures
    Interval: 30s
    Timeout: 5s
    Matcher: 200
```

**Deregistration delay** (default: 300s) — when ECS drains a task, the ALB stops sending new requests but waits this long for in-flight requests to complete before removing the target. For Winamax's workloads, this should match the actual max request duration. An odds query probably completes in <1s; a long-running report query might need 30s.

### TLS termination

ALB terminates TLS. The certificate lives in ACM (AWS Certificate Manager). Backend connections to ECS tasks can be HTTP (unencrypted internally, behind the VPC). This is the standard pattern — mutual TLS between services is a separate concern handled at the app/service mesh layer.

### Sticky sessions

ALB can route all requests from the same client to the same target (based on a cookie). Use only when your application has session state that is not stored externally. For Winamax's scale with Redis for session state, sticky sessions are likely not needed.

---

## NLB — Network Load Balancer (Layer 4)

NLB routes TCP, UDP, and TLS connections by IP and port only. It does not read the HTTP request.

### Key properties

- **Ultra-low latency** — NLB processes packets at wire speed. It does not buffer or terminate connections.
- **Preserves source IP** — the backend server sees the real client IP, not the load balancer IP.
- **Static IPs** — NLB gets one static Elastic IP per AZ. Useful when clients need to whitelist IPs.
- **No content-based routing** — no path rules, no hostname rules.

### When to use NLB over ALB

| Scenario | Why NLB |
|--|--|
| WebSocket for live odds at extreme scale | Raw TCP, no HTTP overhead |
| Database proxy (RDS Proxy, pgBouncer) | TCP-only protocol |
| gRPC where source IP matters for auth | Source IP preservation |
| Compliance: client must see static LB IPs | Static Elastic IPs per AZ |

### ALB as NLB target

You can put an NLB in front of an ALB. This gives you: static IPs (NLB) + content-based routing (ALB). Useful when clients require IP whitelisting but you still need HTTP routing.

---

## Health checks: ALB vs NLB

| | ALB | NLB |
|--|--|--|
| Protocol | HTTP, HTTPS, gRPC | TCP, HTTP, HTTPS |
| Check method | HTTP request to /path | TCP connect or HTTP |
| Stateful? | No — each check is independent | No |
| When a target is unhealthy | Removed from rotation | Connection refused (TCP RST) |

**Interview trap:** "What happens if all targets in a target group are unhealthy?" → ALB fails open (sends to all targets anyway). NLB also fails open for TCP. This is important: a misconfigured health check that marks all tasks unhealthy does not result in a 503 — it results in traffic going to degraded targets.

---

## Connection draining / deregistration

When ECS stops a task, the sequence is:
1. ECS sends deregister request to ALB target group.
2. ALB stops sending new connections to that target IP.
3. ALB waits for the deregistration delay (default 300s) for in-flight requests to complete.
4. ECS sends SIGTERM to the container.
5. After the deregistration delay (or when connections close), the target is removed.

**Common mistake:** Setting deregistration delay to 0 to speed up deployments. This causes in-flight requests to be dropped when a task stops. The right value is: `expected max request duration * 1.5`.

---

## K8s bridge

| K8s | AWS |
|--|--|
| Service type LoadBalancer | ALB or NLB |
| Ingress / IngressController | ALB Listener + Listener Rules |
| Service port + selector | Target Group |
| Readiness probe | ALB Health Check |
| Pod IP registered | Task IP registered (awsvpc mode) |

The key difference: in Kubernetes, kube-proxy handles load balancing at L4 in-cluster using iptables. ALB replaces this for external-facing traffic and provides L7 routing that kube-proxy never had.
