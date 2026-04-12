# Linux Debugging 02 — Container Debugging

## How to use this file

Each scenario gives you a starting point. Write the next command before reading on.

---

## Scenario 1: Container is running but you cannot exec into it (no shell)

**Context:** The ECS task is running. You try:
```bash
aws ecs execute-command \
  --cluster winamax-prod \
  --task abc123 \
  --container bet-validator \
  --interactive \
  --command "/bin/sh"
```

**Response:**
```
An error occurred (InvalidParameterException): The execute command failed because
execute command was not enabled when the task was run.
```

**What does this mean and how do you debug the running container another way?**

---

ECS Exec requires `enableExecuteCommand: true` on the service and the `ssmmessages` permissions on the task role. If it was not enabled at deploy time, you cannot exec into the running task.

**Alternative debugging paths without exec:**

**Path 1 — CloudWatch Logs**
```bash
# Get the log stream for this specific task
LOG_GROUP="/ecs/bet-validator"
LOG_STREAM="ecs/bet-validator/abc123def456"  # task ID is part of stream name

aws logs get-log-events \
  --log-group-name $LOG_GROUP \
  --log-stream-name $LOG_STREAM \
  --limit 100 \
  --query 'events[*].message' \
  --output text
```

**Path 2 — Run a debug task alongside**

Register a new task definition revision with the same image but override the command to `sleep 3600`. Deploy it as a standalone task with ECS Exec enabled. Use it to inspect the environment, test connectivity, and read the filesystem — it runs in the same VPC and same security groups.

```bash
aws ecs run-task \
  --cluster winamax-prod \
  --task-definition bet-validator \
  --launch-type FARGATE \
  --network-configuration "..." \
  --overrides '{"containerOverrides":[{"name":"bet-validator","command":["sleep","3600"]}]}' \
  --enable-execute-command

# Then exec into it
aws ecs execute-command \
  --cluster winamax-prod \
  --task <new-task-id> \
  --container bet-validator \
  --interactive \
  --command "/bin/sh"
```

**Path 3 — Run the image locally with production env vars**

Pull the same image and run it locally with the same environment variables (from Secrets Manager). You can reproduce the issue without touching production.

```bash
# Get the task definition's environment and secrets
aws ecs describe-task-definition --task-definition bet-validator \
  --query 'taskDefinition.containerDefinitions[0]'

# Get secret values
aws secretsmanager get-secret-value --secret-id winamax/prod/bet-validator/db-url \
  --query SecretString --output text

# Run locally
docker run -it --rm \
  -e DB_URL="..." \
  -e KAFKA_BROKERS="..." \
  123456.dkr.ecr.eu-west-3.amazonaws.com/bet-validator:sha-abc123 \
  /bin/sh
```

---

## Scenario 2: `nsenter` — enter a container's namespace on EC2-backed ECS

**Context:** Your ECS service runs on EC2-backed tasks (not Fargate). You can SSH to the EC2 instance. The container is running but has no shell installed.

```bash
# SSH to the EC2 instance
ssh ec2-user@10.0.1.50

# Find the container's PID
docker ps | grep bet-validator
# CONTAINER ID: abc123def456

docker inspect abc123def456 --format '{{.State.Pid}}'
# Output: 18234

# Enter the container's network namespace
nsenter -t 18234 -n -- ss -tnp
# This runs ss inside the container's network namespace
# without needing a shell inside the container itself

# Check what the container can resolve
nsenter -t 18234 -n -- nslookup aurora.cluster.eu-west-3.rds.amazonaws.com

# Test TCP connectivity from inside the container's network context
nsenter -t 18234 -n -- bash -c "echo > /dev/tcp/10.0.3.45/5432" && echo "open" || echo "closed"

# Enter multiple namespaces (network + PID)
nsenter -t 18234 -n -p -- ps aux
```

**What `-n` means:** enter the network namespace. What `-p` means: enter the PID namespace. What `-m` means: enter the mount namespace (filesystem).

This is the most powerful debugging technique for distroless containers — no shell needed.

---

## Scenario 3: Reading `/proc` for a running process

**Context:** A Kafka consumer's memory is growing. You want to understand what files it has open and how much memory it is using — without restarting it.

```bash
PID=18234

# Memory usage breakdown
cat /proc/$PID/status | grep -E "VmRSS|VmSize|VmPeak|Threads"
# VmRSS: Resident Set Size — actual physical memory used
# VmSize: Virtual memory — can be much larger than RSS
# Threads: number of threads

# Open file descriptors (check for leaks)
ls -la /proc/$PID/fd | wc -l
ls -la /proc/$PID/fd | tail -20
# Each line is an open fd — if the count grows over time, you have a leak

# Network connections for this specific process
cat /proc/$PID/net/tcp
# Hex-encoded IPs and ports — harder to read but always available

# Maps — what memory regions are allocated
cat /proc/$PID/maps | head -20
# Shows shared libraries, heap, stack, anonymous mappings

# Environment variables
cat /proc/$PID/environ | tr '\0' '\n' | grep -E "KAFKA|DB|ENV"
# Verify the container received the correct environment
```

**Reading `/proc/$PID/fd` for file descriptor leaks:**

```bash
# Count open FDs now
FD_COUNT_1=$(ls /proc/$PID/fd 2>/dev/null | wc -l)
sleep 60
FD_COUNT_2=$(ls /proc/$PID/fd 2>/dev/null | wc -l)

echo "FDs before: $FD_COUNT_1"
echo "FDs after:  $FD_COUNT_2"
echo "Delta: $((FD_COUNT_2 - FD_COUNT_1))"

# If delta > 0 consistently: file descriptor leak
# What kind of fd is growing?
ls -la /proc/$PID/fd | awk '{print $NF}' | sed 's/[0-9]//g' | sort | uniq -c | sort -rn
```

---

## Scenario 4: Container keeps restarting — find the exit code and cause

**Context:** An ECS task is in a restart loop. Desired: 3, Running: 0-1 (keeps cycling).

```bash
# Step 1: Get stopped task ARNs
STOPPED_TASKS=$(aws ecs list-tasks \
  --cluster winamax-prod \
  --service-name bet-validator \
  --desired-status STOPPED \
  --query 'taskArns' \
  --output text)

# Step 2: Get exit codes from stopped tasks
aws ecs describe-tasks \
  --cluster winamax-prod \
  --tasks $STOPPED_TASKS \
  --query 'tasks[*].{
    StopCode: stopCode,
    StoppedReason: stoppedReason,
    ExitCode: containers[0].exitCode,
    ContainerReason: containers[0].reason
  }'
```

**Exit code reference:**

| Exit Code | Meaning | Common Cause |
|-----------|---------|--------------|
| 0 | Clean exit | Container finished its work (wrong for a server) |
| 1 | Generic error | Application exception, missing config |
| 127 | Command not found | Wrong CMD in Dockerfile, binary not in PATH |
| 137 | SIGKILL | OOM killer, or `docker kill`, or health check timeout |
| 139 | Segfault | Native code crash, corrupted memory |
| 143 | SIGTERM | Graceful shutdown requested (ECS task stopped) |
| 255 | Catchall | Various |

**Exit code 137 specifically:**

```bash
# Check if it's OOM
dmesg | grep -i "oom\|out of memory\|killed process" | tail -20

# Or in CloudWatch
aws logs filter-log-events \
  --log-group-name /ecs/bet-validator \
  --filter-pattern "OutOfMemory OR Killed OR killed" \
  --start-time $(date -d '1 hour ago' +%s000)
```

---

## Scenario 5: `strace` — what is the process actually doing?

**Context:** A service is hung. CPU is 0%, no logs, not responding to requests. You need to know where it is stuck.

```bash
PID=18234

# Attach strace to the running process
strace -p $PID -e trace=network,ipc 2>&1 | head -30
```

**Output:**
```
strace: Process 18234 attached
epoll_wait(7, [], 1024, 30000) = 0
epoll_wait(7, [], 1024, 30000) = 0
epoll_wait(7, [], 1024, 30000) = 0
```

The process is in `epoll_wait` — it is waiting for I/O events. This is normal for a server waiting for requests. Not hung.

**Output for a stuck process:**
```
strace: Process 18234 attached
futex(0x7f8ab4009e54, FUTEX_WAIT_PRIVATE, 0, NULL
```

`futex FUTEX_WAIT` means the process is blocked waiting for a lock. This could be:
- A mutex deadlock
- A blocked database query (connection is waiting for the DB)
- A blocked channel/queue operation

**Trace only system calls related to network:**
```bash
strace -p $PID -e trace=network -f 2>&1 | grep -v "^---" | head -50
# -f: follow child threads/processes
# -e trace=network: only show network syscalls (connect, send, recv, etc.)
```

**Trace with timing:**
```bash
strace -p $PID -T 2>&1 | head -30
# -T: show time spent in each syscall
# A syscall taking > 1s is your bottleneck
```
