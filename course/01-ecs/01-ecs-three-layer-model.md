### The three-layer model

```
Cluster
  └── Service
        └── Task (running container)
```

**Cluster** — A scheduling boundary and resource pool. When you launch EC2 instances into a cluster, each runs the **ECS Agent** — a daemon that registers the instance with the cluster via the `RegisterContainerInstance` API, reports available CPU/memory to the scheduler, receives task placement instructions, and sends heartbeats back. The cluster is a dynamic pool of these capacity records. The scheduler queries this pool when placing a task. On Fargate, there are no agents — the cluster becomes a pure logical namespace and AWS provisions an isolated microVM per task behind the scenes. Either way, the cluster holds no state about your containers — it is just the aggregation point and namespace in which services and tasks live.

**Service** — A long-running reconciliation controller that continuously reconciles desired state against actual state. It does three things simultaneously: (1) **desired count management** — watches how many tasks are in `RUNNING` state and places new ones if the count drops, same loop as a K8s ReplicaSet controller; (2) **task placement** — when launching a new task, runs a placement algorithm against the cluster's capacity pool using your placement constraints (hard rules) and strategies (soft preferences like spread across AZs or binpack by CPU); (3) **load balancer integration** — holds a reference to an ALB target group, calls the ELB API to register each new task's IP and port when it starts, deregisters it when it stops, and waits for connection draining to complete before sending SIGTERM. It is not a network proxy and does not handle service discovery — that is done separately via AWS Cloud Map or ALB DNS.

**Task** — A single running instantiation of a Task Definition. It moves through states: `PROVISIONING → PENDING → RUNNING → STOPPING → STOPPED`. On EC2, it is one or more Docker containers on a host sharing a network namespace (one ENI, one private IP in `awsvpc` mode) and a cgroup enforcing the CPU and memory limits. On Fargate it is the same model but the host is a Firecracker microVM provisioned exclusively for that task. Every running task has access to `http://169.254.170.2` — a link-local endpoint that serves temporary IAM credentials for the task role. Tasks are ephemeral — when one stops and ECS replaces it, the replacement gets a new task ID, new IP, new ENI. Any state held in memory or on local disk is gone.

**Task Definition** — A versioned, immutable blueprint that answers three questions: what to run, with what resources, and with what identity. Every update creates a new revision (`my-service:1`, `:2`, `:3`…) — old revisions are never mutated. It declares: the container image, CPU and memory at both task level (used by the scheduler for placement) and container level (enforced by Docker cgroups at runtime), network mode, two IAM roles (`executionRoleArn` for the agent to pull images and write logs; `taskRoleArn` for the app to call AWS services at runtime), environment variables, secrets fetched from Secrets Manager at startup, health check, log configuration, and optional volumes. The service points to a specific revision — deploying a new image means registering a new revision and updating that pointer.

---
