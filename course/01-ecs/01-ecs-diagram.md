# ECS Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════╗
║  AWS ACCOUNT / VPC                                                               ║
║                                                                                  ║
║  ┌───────────────────────────────────────────────────────────────────────────┐   ║
║  │  CLUSTER  (logical namespace + capacity pool)                             │   ║
║  │                                                                           │   ║
║  │  Capacity Providers attached:  [ ASG: ec2-pool ]  [ FARGATE ]            │   ║
║  │                                                                           │   ║
║  │  ┌─────────────────────────────────────────────────────────────────────┐  │   ║
║  │  │  SERVICE  (reconciliation controller)                               │  │   ║
║  │  │                                                                     │  │   ║
║  │  │  desiredCount: 4          minimumHealthyPercent: 100                │  │   ║
║  │  │  taskDefinition: my-svc:7 maximumPercent: 200                       │  │   ║
║  │  │  placementStrategy: spread across AZs                               │  │   ║
║  │  │  targetGroup: arn:aws:elasticloadbalancing:…/my-svc-tg              │  │   ║
║  │  │                                                                     │  │   ║
║  │  │  [ registers / deregisters tasks into ALB target group ]           │  │   ║
║  │  │  [ replaces failed tasks, drives rolling deploys ]                  │  │   ║
║  │  │                                                                     │  │   ║
║  │  │  ┌──────────────────────┐   ┌──────────────────────┐               │  │   ║
║  │  │  │  TASK (running)      │   │  TASK (running)      │  …x4 total    │  │   ║
║  │  │  │                      │   │                      │               │  │   ║
║  │  │  │  State: RUNNING       │   │  State: RUNNING      │               │  │   ║
║  │  │  │  IP: 10.0.1.45        │   │  IP: 10.0.2.12       │               │  │   ║
║  │  │  │  ENI: eni-0a1b…       │   │  ENI: eni-0c3d…      │               │  │   ║
║  │  │  │  TaskRole → IAM creds │   │  TaskRole → IAM creds│               │  │   ║
║  │  │  │                      │   │                      │               │  │   ║
║  │  │  │  ┌────────────────┐  │   │  ┌────────────────┐  │               │  │   ║
║  │  │  │  │  container     │  │   │  │  container     │  │               │  │   ║
║  │  │  │  │  app:1.2.3     │  │   │  │  app:1.2.3     │  │               │  │   ║
║  │  │  │  │  cpu: 512      │  │   │  │  cpu: 512      │  │               │  │   ║
║  │  │  │  │  mem: 1024 MB  │  │   │  │  mem: 1024 MB  │  │               │  │   ║
║  │  │  │  │  port: 3000    │  │   │  │  port: 3000    │  │               │  │   ║
║  │  │  │  └────────────────┘  │   │  └────────────────┘  │               │  │   ║
║  │  │  │  [shared net ns]     │   │  [shared net ns]     │               │  │   ║
║  │  │  │  [shared cgroup]     │   │  [shared cgroup]     │               │  │   ║
║  │  │  └──────────────────────┘   └──────────────────────┘               │  │   ║
║  │  └─────────────────────────────────────────────────────────────────────┘  │   ║
║  │                                                                           │   ║
║  │  EC2 INSTANCES (ECS Agent running on each)                               │   ║
║  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                   │   ║
║  │  │ i-0a1b  AZ-a │  │ i-0c3d  AZ-b │  │ i-0e5f  AZ-c │                   │   ║
║  │  │ cpu: 4096    │  │ cpu: 4096    │  │ cpu: 4096    │                   │   ║
║  │  │ mem: 8192 MB │  │ mem: 8192 MB │  │ mem: 8192 MB │                   │   ║
║  │  │ [ECS Agent]  │  │ [ECS Agent]  │  │ [ECS Agent]  │                   │   ║
║  │  │  ↕ heartbeat │  │  ↕ heartbeat │  │  ↕ heartbeat │                   │   ║
║  │  │  reports     │  │  reports     │  │  reports     │                   │   ║
║  │  │  capacity    │  │  capacity    │  │  capacity    │                   │   ║
║  │  └──────────────┘  └──────────────┘  └──────────────┘                   │   ║
║  └───────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                  ║
╚══════════════════════════════════════════════════════════════════════════════════╝


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TASK DEFINITION (blueprint — versioned, immutable)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  family: my-svc                    revision: 7  (immutable once registered)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  IDENTITY                                                               │
  │  executionRoleArn → ECS agent uses this to:                            │
  │      pull image from ECR                                               │
  │      write logs to CloudWatch                                          │
  │      fetch secrets from Secrets Manager at startup                     │
  │                                                                        │
  │  taskRoleArn      → app code uses this at runtime to:                  │
  │      call S3, DynamoDB, SQS, etc.                                      │
  │      credentials served via http://169.254.170.2 (link-local endpoint) │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  RESOURCES                                                             │
  │  task cpu: 1024 units   task memory: 2048 MB  ← used for placement    │
  │                                                                        │
  │  container: app                                                        │
  │    image:   123456789.dkr.ecr.eu-west-1.amazonaws.com/my-svc:1.2.3    │
  │    cpu:     512 units   (Docker cgroup enforcement)                    │
  │    memory:  1024 MB hard limit  (OOM kill if exceeded)                 │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  NETWORKING                                                            │
  │  networkMode: awsvpc  → task gets its own ENI + private IP             │
  │  portMappings: containerPort 3000                                      │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  CONFIG & SECRETS                                                      │
  │  environment:  NODE_ENV=production          (plaintext, in definition) │
  │  secrets:      DATABASE_URL ← Secrets Manager ARN  (fetched at start) │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  HEALTH CHECK                                                          │
  │  command:     curl -f http://localhost:3000/health                     │
  │  interval:    30s   timeout: 5s   retries: 3   startPeriod: 60s       │
  │                    ↑ app has 60s to boot before failures count         │
  ├─────────────────────────────────────────────────────────────────────────┤
  │  LOGGING                                                               │
  │  driver: awslogs                                                       │
  │  group:  /ecs/my-svc   region: eu-west-1   prefix: ecs                │
  └─────────────────────────────────────────────────────────────────────────┘


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  TRAFFIC FLOW (request in → task out)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Internet
    │
    ▼
  ALB  (Application Load Balancer)
    │   listener: 443 → target group: my-svc-tg
    │   health check: GET /health every 30s
    │   only routes to tasks that PASS health check
    ▼
  Target Group: my-svc-tg
    │   registered members: task IPs registered by the Service on startup
    │   deregistered by Service on task stop (draining before SIGTERM)
    ▼
  Task IP:Port  (10.0.1.45:3000)
    │
    ▼
  Container: app  (port 3000)


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLLING DEPLOY SEQUENCE  (minimumHealthyPercent:100 / maximumPercent:200)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  t=0   [v1][v1][v1][v1]                         4 old tasks running
  t=1   [v1][v1][v1][v1] [v2][v2][v2][v2]        launch 4 new tasks (200% cap)
  t=2   [v1][v1][v1][v1] [v2][v2][v2][v2]        new tasks pass health check
                                                  ALB registers new IPs
  t=3              [DRAIN old tasks]              ALB stops sending new reqs to v1
                                                  in-flight requests complete
  t=4                     [v2][v2][v2][v2]        old tasks stopped, back to 100%


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  KUBERNETES MAPPING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ECS Cluster          ≈  K8s Cluster (data plane only — control plane is AWS)
  ECS Service          ≈  Deployment + Service (combined)
  Task Definition      ≈  Pod spec + ConfigMap + ServiceAccount (combined, versioned)
  Task                 ≈  Pod
  executionRoleArn     ≈  kubelet image pull secret + log permissions
  taskRoleArn          ≈  ServiceAccount IAM Role (IRSA)
  awsvpc ENI per task  ≈  CNI plugin giving each pod its own IP
  ALB target group     ≈  kube-proxy + Endpoints object
  CloudWatch Logs      ≈  kubectl logs / log aggregator
  ECS Exec             ≈  kubectl exec
```
