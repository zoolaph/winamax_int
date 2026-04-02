# Exercise 3 — ALB Listener Rules for Microservices

## Scenario

Winamax runs these services behind a single ALB (`alb-prod`):

| Service | Target Group | Path/Host | Notes |
|--|--|--|--|
| Main frontend | tg-frontend | `winamax.fr` / `www.winamax.fr` | Static SPA served from here |
| Betting API | tg-api-bets | `api.winamax.fr/bets/*` | Critical path, latency-sensitive |
| Odds API (live) | tg-api-odds-live | `api.winamax.fr/odds/live/*` | Ultra-low latency, no caching |
| Odds API (pre-match) | tg-api-odds-prematch | `api.winamax.fr/odds/prematch/*` | Cacheable |
| Admin panel | tg-admin | `admin.winamax.fr` | Internal only — must block public |
| Health endpoint | (fixed response) | `*/health` | ALB health check, return 200 |

---

## Task 1: Write the listener rules

Write ALB listener rules for `HTTPS:443` in priority order. Use this format:

```
Priority: XX
  Condition: [condition type] [value]
  Action: [action]
```

Consider: how do you block the admin panel from public access? What priority should the health check rule be?

---

## Task 2: Health check configuration

Write the health check config for `tg-api-bets`:
- The API takes ~3 seconds to start
- Normal response time is <100ms
- Health endpoint: `GET /health` → returns `{"status": "ok"}` with HTTP 200
- You want fast failure detection but not too many false positives

Fill in:
```
Health check:
  Protocol: HTTP
  Path: ?
  Port: traffic-port
  Healthy threshold:   ? consecutive successes
  Unhealthy threshold: ? consecutive failures
  Interval: ?s
  Timeout:  ?s
  startPeriod: ?s
```

---

## Task 3: Deregistration delay

The betting API processes bets that take up to 2 seconds to complete. During a rolling deployment:
1. What should the `deregistration_delay` be set to for `tg-api-bets`?
2. What happens to in-flight bet requests when an ECS task receives SIGTERM?
3. How does ECS coordinate with ALB during task shutdown?

---

## Answer Key

### Task 1: Listener rules

```
Priority: 10
  Condition: path-pattern = */health
  Action: fixed-response 200 Content-Type=text/plain Body="ok"
  Reason: Matches health checks from any host before any other rule. No origin needed.

Priority: 20
  Condition: host-header = admin.winamax.fr
             source-ip NOT in 10.0.0.0/8 (internal IP range)
  Action: fixed-response 403 Body="Forbidden"
  Note: ALB source-ip conditions match client IP. Block any non-internal source.

Priority: 25
  Condition: host-header = admin.winamax.fr
  Action: forward to tg-admin
  Reason: Only reachable if priority 20 didn't match (i.e., source IS internal)

Priority: 30
  Condition: host-header = api.winamax.fr
             path-pattern = /odds/live/*
  Action: forward to tg-api-odds-live

Priority: 40
  Condition: host-header = api.winamax.fr
             path-pattern = /odds/prematch/*
  Action: forward to tg-api-odds-prematch

Priority: 50
  Condition: host-header = api.winamax.fr
             path-pattern = /bets/*
  Action: forward to tg-api-bets

Priority: 60
  Condition: host-header = api.winamax.fr
  Action: forward to tg-api-bets (default API catch-all)

Default action:
  Condition: (all other requests)
  Action: forward to tg-frontend
  Reason: winamax.fr and www.winamax.fr hit the default

Note: ALB does NOT support IP blocking natively for complex cases — a WAF (AWS WAF) 
attached to the ALB is the proper way to restrict by source IP for the admin panel.
The source-ip condition is limited in ALB rules. For production, use WAF.
```

### Task 2: Health check

```
Health check:
  Protocol: HTTP
  Path: /health
  Port: traffic-port
  Healthy threshold:   2 consecutive successes   → declared healthy after 2 good checks
  Unhealthy threshold: 3 consecutive failures    → declared unhealthy after 3 bad checks
  Interval: 15s   → check every 15s (balance between fast detection and noise)
  Timeout:  5s    → wait 5s for response before counting as failure
  startPeriod: 5s (set in ECS task definition, not ALB — gives container 5s before health checks count)
```

With interval=15s and unhealthy threshold=3: a healthy task fails after 3×15s = 45 seconds of failure. Fast enough for incident response, slow enough to avoid flapping.

The 3-second startup time: set `startPeriod: 5` in the ECS container health check (or set a grace period in the ECS service). The ALB itself doesn't have a startPeriod — ECS controls when the task is registered with the target group (typically only after the ECS container health check passes, if configured).

### Task 3: Deregistration delay

1. **`deregistration_delay`: 10 seconds** — bets take max 2s, so 10s gives a 5x safety margin for in-flight requests to complete, without holding up deployments unnecessarily. 300s (default) is too long.

2. When SIGTERM is received, the application should:
   - Stop accepting new connections (the ALB is already stopped routing to it)
   - Finish in-flight requests
   - Exit gracefully
   
   If the application ignores SIGTERM, after `stopTimeout` (ECS task definition `stopTimeout`, default 30s), ECS sends SIGKILL and kills the process — dropping any in-flight requests.

3. ECS + ALB coordination sequence:
   - ECS calls ALB: deregister this task IP from target group
   - ALB stops sending NEW requests to this task (connection draining begins)
   - ALB waits `deregistration_delay` seconds for existing connections to close
   - After deregistration_delay elapses, ALB marks the target as deregistered
   - ECS sends SIGTERM to the container
   - Container finishes in-flight work and exits
   - ECS sends SIGKILL if container hasn't exited after `stopTimeout`

   The deregistration_delay should be >= max request duration. The ECS `stopTimeout` should be >= deregistration_delay + max request duration.
