# 90-Second Answers

## How to use this file

Each answer below is compressed to interview length — the version you deliver out loud in under 90 seconds. The full version is in the course files. These are your delivery drafts.

**Practice method:**
1. Read the question
2. Close the file
3. Answer out loud, timing yourself
4. If you go over 90 seconds or miss a key point, re-read and try again

The goal is not to memorize these words. The goal is to internalize the structure so you can deliver it naturally.

---

## Kafka

**"What is consumer lag and how do you alert on it?"**

> Consumer lag is the gap between the latest message in a partition and the last committed offset of a consumer group — it tells you how far behind the consumer is.
>
> Lag alone is not enough to alert on. I alert on two things: lag above a threshold sustained for a meaningful window — for the fraud detection consumer, 10,000 messages for 2 minutes is critical — and lag that is actively growing. A growing rate means the consumer is falling behind indefinitely, which I detect with a `deriv()` alert in Prometheus.
>
> I also alert on zero offset advancement — the consumer is stuck, probably on a poison message. And I use per-partition lag heatmaps in Grafana: if one partition has 500k lag while others are fine, that is almost always a hot partition or a poison message, not a throughput problem. That distinction changes your response completely.

---

**"You have 75k messages/sec and consumers are falling behind. What do you do?"**

> Diagnose before acting. Falling behind is a symptom, not a cause.
>
> First I look at the partition breakdown. If lag is even across all partitions, it's throughput — consumers are too slow. If it's concentrated on one or two partitions, it's a hot partition or a poison message, and scaling consumers won't help.
>
> For a throughput problem: check how many consumers versus partitions. If I have 24 partitions and 8 consumers, I scale to 24 consumers immediately — that's a 3x throughput gain with no code change. If I'm already at one consumer per partition, the bottleneck is inside each consumer — slow DB write, expensive computation. I profile the consumer to find the hot path.
>
> For a poison message: DLQ the message and advance the offset. For a hot partition: the real fix is partition count or key distribution, neither of which is a 2 AM fix. Tonight I stop the source of the spike and accept the lag.

---

## Observability

**"How do you sample traces at 75k messages/second without losing error traces?"**

> Tail-based sampling at the OTel Collector. The problem with head-based sampling is that you decide whether to keep a trace before you know if it's going to error. At 5% head sampling, you drop 95% of error traces — exactly what you need most.
>
> Tail-based sampling buffers all spans until the trace completes, then applies policies: always keep errors, always keep anything over 300ms, always keep the betting and payment critical paths. For healthy, fast, non-critical traffic — 5% probabilistic sampling.
>
> The operational constraint: all spans for a trace must arrive at the same Collector instance, otherwise the policy can't see the complete trace. I solve this with consistent hash routing on trace ID at the Collector gateway's load balancer.
>
> The trade-off: the Collector buffers in-flight traces in memory. At our volume I size this carefully and put a memory limiter processor first — if the Collector approaches its memory limit, it sheds load gracefully rather than crashing.

---

## Terraform

**"What is Terraform drift and how do you detect and remediate it?"**

> Drift is when real AWS state diverges from what Terraform's state file says — someone made a manual console change, AWS modified an attribute automatically, or a partial apply left things inconsistent.
>
> Detection: I run `terraform plan -detailed-exitcode` on a schedule — every 6 hours via GitHub Actions. Exit code 2 means changes are present, which fires a Slack alert with the plan excerpt. Exit code 1 means the plan itself errored — that's a different alert because the detection system is broken, not just drift.
>
> The detection role is read-only — it can plan but not apply. Even if someone misconfigures the pipeline, it can never accidentally fix drift by applying.
>
> Remediation: if drift is unauthorized (someone clicked in the console), I apply to restore desired state. If it's intentional and should be permanent, I update the `.tf` files to match reality. Prevention is more important than detection — IAM policies that restrict console write access to production make Terraform the only path to changes.

---

## AWS / ECS

**"Walk me through how an HTTP request reaches an ECS task in a private subnet."**

> The request hits Route 53 first, which resolves the hostname to the ALB's IP. The browser opens a TCP connection and TLS handshake with the ALB.
>
> The ALB terminates TLS, evaluates its listener rules — host header, path pattern — and picks a healthy target from the target group. It routes the decrypted request to the selected ECS task's private IP on the container port, say 8080.
>
> The ECS task is in a private subnet with no public IP. The ALB reaches it via private IP routing within the VPC. The task's security group allows inbound 8080 from the ALB's security group. The task processes the request, responds to the ALB, and the ALB sends it back to the user over the existing TLS connection.
>
> The task never touches the internet directly. The only inbound path is through the ALB.

---

**"What is the difference between the ECS execution role and the task role?"**

> They serve completely different purposes and are used by different identities.
>
> The execution role is used by the ECS agent — before the container even starts. It needs to pull the image from ECR, fetch secrets from Secrets Manager at launch, and write container stdout to CloudWatch Logs. The application code never uses this role.
>
> The task role is used by the application at runtime. The ECS agent injects temporary credentials for this role into the task metadata endpoint. When the app calls the AWS SDK — S3, SQS, DynamoDB — those calls use the task role.
>
> The diagnostic split is clean: task won't start, image won't pull, secrets won't load — check the execution role. Task starts fine but the app gets 403s on AWS API calls — check the task role.
>
> In Kubernetes terms: the execution role is like the kubelet's access to pull images. The task role is like IRSA — the application's own AWS identity.

---

## Incidents

**"Tell me about a real incident you owned end-to-end."**

> We had a degradation where API Gateway was intermittently dropping connections under load — RAM would climb, connections would drop, then partially recover. A sawtooth pattern. Because it never fully crashed, it wasn't immediately obvious.
>
> I traced the connection count and found it was proportional to the number of services calling the auth endpoint. Each service was authenticating on every request — every second, regardless of whether its existing token was still valid. With N services, that's N requests per second, all holding synchronous connections open at API Gateway.
>
> The key insight: API Gateway is synchronous with no buffer. Unlike a queue where pressure means longer waits, API Gateway has a finite connection pool. When it fills, connections are refused immediately — which explains the sharp drops rather than gradual degradation.
>
> The fix was token caching at the client side. Each service authenticates once and reuses the token until close to expiry, with a 30-second buffer before the exp claim. Auth request volume dropped ~90% and the connection pressure disappeared.
>
> The monitoring gap: we had no metric for auth request rate by caller, and no alert on connection pool utilization. We added both — 80% pool utilization for 3 minutes pages the on-call. That would have caught this 10 minutes before users noticed.

---

## Behavioral

**"Why Winamax specifically?"**

> Two things. First, the operational scale is real — 900,000 bets a day, 75,000 messages per second on Kafka, 700 microservices. That is not a toy problem. The reliability and observability challenges at that scale are exactly the kind of work I want to be solving.
>
> Second, the Devoxx talk on the self-hosted observability stack. Building OTel plus Jaeger plus Quickwit instead of buying Datadog, for GDPR reasons, not just cost — that is an engineering team making principled architectural decisions. That approach resonates with how I think about platform engineering.
>
> I come from a Kubernetes background where I have solved HA, container orchestration, observability, and incident response in production. ECS is a different control plane but the distributed systems problems are identical. I want to apply that depth to an environment where it actually matters.

---

**"How do you handle being on-call for a system you did not build?"**

> You invest in understanding before you are paged. When I join a new team, I spend the first weeks reading runbooks, reviewing dashboards, following along with incidents as a secondary, and asking the engineers who built each system what they are most worried about. Not what breaks often — what would be hard to recover from.
>
> When I am paged at 2 AM for an unfamiliar system, my first principle is: do not make it worse. I diagnose before I act. I read the alert, check the obvious metrics, and if I do not understand what I am looking at, I escalate rather than guess. A bad escalation is better than a bad fix.
>
> Over time, being on-call is the best way to learn a system deeply. Every incident is a learning event. I write post-mortems even for incidents I cause — especially for those.
