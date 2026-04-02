# Module 5 Interview Questions — AWS Core: Networking, IAM, and Foundational Services

These are the questions Winamax will actually ask. Each answer is written in the voice you should use: direct, operational, connected to their context.

---

## Q1: Walk me through how an HTTP request reaches an ECS task in a private subnet.

**Answer:**

The request hits Route 53 first. Route 53 resolves the hostname — say `api.winamax.fr` — to the ALB's IP address. The user's DNS resolver gets that IP, the browser opens a TCP connection and does a TLS handshake with the ALB.

The ALB terminates TLS. It evaluates its listener rules — host-header and path-pattern match — and selects a target group. The ALB picks a healthy ECS task IP from the target group using round-robin, and forwards the decrypted HTTP request to that task on the configured port, say 8080.

The ECS task is in a private subnet. The ALB reaches it via private IP routing within the VPC. The task's security group allows inbound on 8080 from the ALB's security group. The task processes the request and sends the response back to the ALB, which sends it back to the user over the existing TLS connection.

The task never has a public IP. The only inbound path from the internet is through the ALB.

---

## Q2: What is the difference between a security group and a NACL? When would you use each?

**Answer:**

The fundamental difference is stateful versus stateless. Security groups are stateful — if I allow inbound TCP on port 443, the return traffic for that connection is automatically allowed without writing an explicit outbound rule. NACLs are stateless — I must write rules for both directions, including the ephemeral port range for return traffic.

Scope is also different. Security groups attach to individual resources — an ECS task, an RDS instance, an ALB — at the ENI level. NACLs attach to subnets and apply to everything in that subnet.

In practice, security groups handle 95% of access control. I define SG-to-SG rules: the ECS task SG allows inbound 8080 from the ALB SG, and the RDS SG allows inbound 5432 from the ECS SG. This is precise and survives IP changes.

I reach for NACLs when I need to block a bad CIDR range across an entire subnet — say, blocking a known malicious IP range during an incident, or when a compliance requirement explicitly calls for subnet-level controls. But I would not try to replace security groups with NACLs.

---

## Q3: An ECS task fails to start. The error says it cannot pull the image from ECR. Walk me through your diagnosis.

**Answer:**

The image pull happens before the container starts, so this is the execution role and network layer, not the application.

First, the execution role. Does it have `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, and `ecr:GetDownloadUrlForLayer`? These three are the minimum for an image pull. Also check `ecr:BatchCheckLayerAvailability`. If any are missing, the pull fails silently or with AccessDenied.

Second, network. The ECS task is in a private subnet. To reach ECR, it needs one of two things: a route to a NAT Gateway, or a VPC Endpoint for ECR. ECR actually uses two endpoints — `ecr.api` for the authorization token and `ecr.dkr` for the actual layer download — plus a Gateway Endpoint for S3, because ECR stores image layers in S3. If any of these are missing or the security group doesn't allow outbound 443, the pull fails.

Third, if using a VPC Endpoint: does the endpoint's security group allow inbound 443 from the task's security group? VPC Interface Endpoints have their own SG.

I would check CloudTrail for the `ecr:GetAuthorizationToken` call to see if it was made and what happened. If the call never appears, it is a network issue. If it appears with AccessDenied, it is the execution role.

---

## Q4: What is the difference between the ECS execution role and the ECS task role?

**Answer:**

They serve completely different purposes and are used by different identities.

The execution role is used by the ECS Agent — the daemon running on the EC2 host or in the Fargate control plane — before the container even starts. It needs to pull the image from ECR, fetch secrets from Secrets Manager or SSM at task startup, and write the container's stdout to CloudWatch Logs. The application code never touches this role.

The task role is used by the application code at runtime. The ECS Agent injects temporary credentials for this role into the task's metadata endpoint at `http://169.254.170.2`. When the application calls the AWS SDK to put a message on SQS or read an object from S3, those calls are made using the task role.

The diagnostic split is clean: if the task won't start — image won't pull, secrets won't load — check the execution role. If the task starts but gets 403s on AWS API calls, check the task role.

In Kubernetes terms: the execution role is like the kubelet's access to the control plane. The task role is like IRSA — the application's own identity for AWS resources.

---

## Q5: How would you design IAM for 700+ microservices to minimize blast radius if one service's credentials are compromised?

**Answer:**

One task role per service, scoped as tightly as possible. Not one shared task role for all services.

For the `payment-api`, the task role gets: SQS access to the payments queue specifically, read access to its own secrets in Secrets Manager, and write access to the payments table in DynamoDB. It cannot touch the odds engine's queue or the user database.

To enforce this, I use resource conditions wherever possible — ARNs with the service name in the path: `arn:aws:secretsmanager:eu-west-3:*:secret:winamax-payments-*`. Even if the policy were ever misconfigured, the resource name constraint limits the scope.

I would use IAM Access Analyzer to audit for over-privileged roles. It shows which permissions were used in the last 90 days — anything not used gets removed.

For the execution role, there is more sharing acceptable since its permissions are always the same (ECR pull, secrets fetch, CloudWatch logs). But I would still scope the Secrets Manager access to the specific secret ARNs the service needs, not `*`.

The principle is: if the payment service is compromised, the attacker gets S3 write to the payment logs bucket. They do not get read access to user credentials or the ability to manipulate the odds data.

---

## Q6: Explain S3 storage classes and how you would use lifecycle rules for Winamax's observability data.

**Answer:**

S3 has several storage classes that trade cost for retrieval speed. Standard is the most expensive but immediate access — use this for recently written data you might need to query. Standard-IA (infrequent access) is cheaper but has a minimum storage duration and per-retrieval cost — use it for data older than 30 days that you access rarely. Glacier Instant Retrieval is cheaper still with millisecond retrieval — good for archive data that might still need to be pulled occasionally. Glacier Deep Archive is the cheapest, with 12-hour retrieval — for data you almost never need but must retain for compliance.

For Winamax's observability data — traces and logs stored in S3 for Quickwit — I would configure lifecycle rules:

Days 0–30: S3 Standard. Engineers are actively debugging issues from recent days.
Days 30–90: S3 Standard-IA. Traces are rarely queried this far back but might be needed for a slow-developing incident analysis.
Days 90–365: S3 Glacier Instant Retrieval. Post-incident reviews and compliance.
Days 365+: Glacier Deep Archive. Legal hold and long-term retention.
After 7 years: expire and delete (gambling regulation retention period in France).

This tiering alone can cut storage costs by 70–80% compared to keeping everything in Standard.

---

## Q7: Why would you use Prometheus + Grafana instead of CloudWatch metrics?

**Answer:**

CloudWatch works well for what AWS provides out of the box — EC2 health, ALB request rates, RDS storage. For those built-in metrics, the integration is zero-configuration and the cost is predictable.

The problem shows up with custom application metrics at scale. In CloudWatch, you pay $0.30 per custom metric per month. At Winamax with 700 services each emitting 50+ metrics, that is 35,000 custom metrics — roughly $10,500 per month just for metrics storage, before queries. The cost scales with cardinality.

With Prometheus, you run the TSDB yourself. The cost is compute and storage — not per-metric. You can instrument with high cardinality (service, endpoint, status_code, customer_tier as labels) without worrying about a per-metric bill.

PromQL is also significantly more expressive than CloudWatch Metric Math. Writing `sum(rate(http_requests_total{status=~"5.."}[5m])) by (service) / sum(rate(http_requests_total[5m])) by (service)` is clean. The CloudWatch equivalent is verbose and harder to compose.

Grafana gives us unified dashboards across Prometheus, Quickwit, and even CloudWatch itself — we can have one pane of glass. Alertmanager gives us routing, silencing, and grouping that CloudWatch Alarms lack.

That said, I keep CloudWatch for AWS-native alarms: billing alerts, EC2 system status checks, RDS storage. Those use built-in metrics with no custom instrumentation cost. The two systems coexist.

---

## Q8: What is the difference between AWS Secrets Manager and SSM Parameter Store? When do you use each?

**Answer:**

The decision hinges on rotation. Secrets Manager is designed specifically for credentials that need to rotate automatically — database passwords, API keys, OAuth secrets. It has a built-in rotation mechanism via Lambda that can rotate a password in RDS, test the new credential, and update the secret, all automatically on a schedule without human intervention. That is a capability SSM Parameter Store does not have.

SSM Parameter Store is free at the Standard tier and is better suited for configuration — database hostnames, feature flag values, queue URLs, service endpoints. Values that change infrequently and do not need automatic rotation. For sensitive values, I use SecureString (encrypted with KMS) in Parameter Store.

The cost difference matters: Secrets Manager is $0.40 per secret per month. For 100 secrets that is $40/month — justified for credentials. For 1,000 config parameters in SSM, it is free.

In ECS, both integrate the same way via the `secrets` field in the task definition. The ECS Agent resolves them at task startup using the execution role. The application sees them as environment variables.

The rule I follow: if it is a credential and it should rotate without manual work, use Secrets Manager. If it is configuration — even sensitive configuration — use SSM Parameter Store with SecureString.

---

## Q9: Walk me through Route 53 failover routing. How would you use it for Winamax's betting API?

**Answer:**

Route 53 failover routing requires two records for the same hostname — a PRIMARY and a SECONDARY. Each record has a health check attached. Route 53 continuously polls the health check endpoints from ~15 locations globally.

When all health checkers report the primary as healthy, Route 53 returns the primary record's value — the Paris ALB IP. When enough health checkers detect the primary is failing (the threshold is >18% reporting failure), Route 53 switches to returning the secondary record.

For Winamax's betting API, I would configure it like this: primary record points to the Paris ALB, health check polling `api.winamax.fr/health` over HTTPS every 10 seconds. Secondary record points to the DR site — either another AWS region or a static fallback page that tells users "maintenance in progress."

The failover speed is roughly: health check interval × failure threshold × DNS TTL. With 10-second intervals, 3-failure threshold, and 60-second TTL: worst case is about 90 seconds from an outage to DNS pointing at the secondary. Better than a human noticing and acting.

The limitation to be honest about: this is DNS-level failover, not instant. The 60-second TTL means some resolvers will keep serving the old record for up to 60 seconds even after Route 53 switches. For the payment API where every second of downtime costs real money, this is complemented by ALB multi-AZ redundancy — Route 53 failover is the last line of defense for a full region failure, not a substitute for HA within a region.
