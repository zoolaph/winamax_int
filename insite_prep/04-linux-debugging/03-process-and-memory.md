# Linux Debugging 03 — Process and Memory

## How to use this file

Each scenario gives you a starting point. Write the next command before reading on.

---

## Scenario 1: Process is consuming 100% CPU — find why

**Context:** One ECS task is at 100% CPU. The task has not crashed. Other tasks are healthy. You exec into the container.

**What do you run first?**

---

```bash
# Step 1: Find what is consuming CPU inside the container
top -b -n 1 -o %CPU

# Or more readable:
ps aux --sort=-%cpu | head -10
```

**Output:**
```
USER  PID %CPU %MEM COMMAND
node  1    99.8  8.1  node /app/consumer.js
```

The node process is consuming all CPU.

```bash
# Step 2: Get a CPU profile (Node.js)
# Send SIGUSR1 to enable the Node.js inspector
kill -SIGUSR1 1

# Or: look at what the process is actually doing
# Take 3 stack samples 1 second apart
for i in 1 2 3; do
  kill -3 1  # SIGQUIT — dumps thread stack trace to stderr
  sleep 1
done

# Read the stack dump from logs
aws logs filter-log-events \
  --log-group-name /ecs/fraud-detection \
  --filter-pattern "at " \
  --start-time $(date -d '2 minutes ago' +%s000) \
  | jq '.events[*].message' | head -30
```

**Common causes of 100% CPU in a Node.js consumer:**

1. **Infinite loop** — a while loop with no await, blocking the event loop
2. **Regex backtracking** — a catastrophic regex applied to user-provided input
3. **JSON.parse on very large messages** — synchronous, blocks the event loop
4. **Crypto operations** — synchronous bcrypt or similar blocking the event loop

**For JVM-based services:**

```bash
# Thread dump — shows what every thread is doing
kill -3 $PID
# Output goes to stdout/logs

# Or use jstack if available
jstack $PID | grep -A 5 "RUNNABLE" | head -50

# Check if GC is consuming CPU (GC storm)
jstat -gcutil $PID 1000 10
# If GC time (GCT) is increasing rapidly: GC pressure
```

---

## Scenario 2: OOM kill — reconstruct what happened

**Context:** An ECS task was OOM killed. You need to understand what caused the memory spike to prevent recurrence.

**What evidence is available after an OOM kill?**

---

```bash
# Step 1: Confirm it was OOM (not a crash or SIGTERM)
# Check the exit code from ECS
aws ecs describe-tasks --cluster winamax-prod \
  --tasks <stopped-task-arn> \
  --query 'tasks[0].containers[0].exitCode'
# 137 = SIGKILL = could be OOM or manual kill

# Check CloudWatch Logs for OOM messages
aws logs filter-log-events \
  --log-group-name /ecs/fraud-detection \
  --filter-pattern "OutOfMemoryError OR heap space OR GC overhead OR Killed" \
  --start-time $(date -d '1 hour ago' +%s000) \
  | jq '.events[*].message'

# On the EC2 host (if EC2-backed):
dmesg | grep -i "oom\|killed process\|out of memory" | tail -20
```

**If it's a JVM OOM:**
```
java.lang.OutOfMemoryError: Java heap space
java.lang.OutOfMemoryError: GC overhead limit exceeded
java.lang.OutOfMemoryError: Metaspace
```

Each has a different cause:
- `Java heap space` — objects are accumulating faster than GC can collect
- `GC overhead limit exceeded` — GC is running but collecting almost nothing (memory is genuinely full)
- `Metaspace` — class loading leak, usually from framework/plugin bugs

**Step 2 — Heap dump analysis (proactive, for next time)**

Add to JVM startup flags:
```
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/tmp/heapdump.hprof
```

Upload to S3 before the container exits:
```bash
# In entrypoint.sh or a JVM shutdown hook
aws s3 cp /tmp/heapdump.hprof s3://winamax-debug-dumps/$(date +%s)-heapdump.hprof
```

**For Node.js — memory growth over time:**

```bash
# If you have the process still running with growing memory:
# Take two heap snapshots and compare

# In Node.js code, add a debug endpoint:
if (process.env.DEBUG_HEAP === 'true') {
  const v8 = require('v8');
  app.get('/debug/heap-snapshot', (req, res) => {
    const snapshot = v8.writeHeapSnapshot('/tmp/heap-' + Date.now() + '.heapsnapshot');
    res.json({ snapshot });
  });
}
```

---

## Scenario 3: Disk full — find what filled it

**Context:** `/` on the EC2 instance is 98% full. ECS tasks are failing to start.

```bash
# Step 1: Find where the disk space went
df -h
# Shows usage by filesystem

# Step 2: Find the large directories
du -sh /* 2>/dev/null | sort -rh | head -20
# Usually: /var/lib/docker or /var/log

# Step 3: Docker-specific
docker system df
# Shows: images, containers, volumes, build cache

# Docker images (most common culprit on ECS EC2)
docker images --format "{{.Size}}\t{{.Repository}}:{{.Tag}}" | sort -rh | head -20

# Dangling images (layers not referenced by any tag)
docker images -f dangling=true

# Step 4: Clean up
docker system prune -f           # removes stopped containers, dangling images, unused networks
docker image prune -a --filter "until=168h"  # remove images not used in 7 days
```

**For ECS EC2 instances specifically:**

The Docker daemon on ECS EC2 instances accumulates old task images. ECS does not clean them up automatically by default. You should:

1. Configure the ECS agent to clean up images: set `ECS_IMAGE_CLEANUP_INTERVAL` and `ECS_IMAGE_MINIMUM_CLEANUP_AGE` in `/etc/ecs/ecs.config`
2. Add a cron job: `docker system prune -f` every night
3. Size the EC2 instance's root volume appropriately for the number of images you pull

---

## Scenario 4: systemd service won't start — read the journal

**Context:** You're debugging an issue on a VM (not a container). A service `kafka-consumer.service` fails to start.

```bash
# Check service status
systemctl status kafka-consumer.service

# Read the journal for this service
journalctl -u kafka-consumer.service -n 50 --no-pager

# Follow logs in real time
journalctl -u kafka-consumer.service -f

# Show logs from the last failed attempt
journalctl -u kafka-consumer.service -n 100 --since "10 minutes ago"

# Check the unit file for misconfiguration
systemctl cat kafka-consumer.service

# Test if the binary runs outside systemd
sudo -u kafka /opt/kafka-consumer/bin/run.sh
# This often reveals "file not found" or permission errors that are masked in the journal
```

**Common systemd failures:**

| Journal output | Cause |
|---|---|
| `code=exited, status=1/FAILURE` | Application exit code 1 — check ExecStart path and arguments |
| `code=exited, status=127` | Command not found — wrong ExecStart path |
| `code=killed, status=9/KILL` | OOM killer or manual kill |
| `Failed to start` with `Permission denied` | Wrong User= in unit file, or file permissions |
| `Start request repeated too quickly` | Service is in a restart loop — check `StartLimitInterval` |

---

## Scenario 5: High load average with normal CPU — the iowait case

**Context:** `uptime` shows load average of 24.0 on a 4-core machine. But `top` shows CPU usage at only 15%. The machine is sluggish.

```bash
uptime
# 21:03:15 up 12 days, load average: 24.12, 21.43, 18.71

top
# %Cpu(s): 14.3 us,  2.1 sy, 0.0 ni, 20.1 id, 63.5 wa, 0.0 hi, 0.0 si
#                                               ↑ 63.5% iowait
```

`wa` (iowait) = 63.5%. The CPU is idle but processes are blocked waiting for disk I/O. Load average counts processes waiting for I/O as "running" for load calculation purposes.

**Find what is causing I/O:**

```bash
# Which processes are reading/writing most?
iotop -o -b -n 3
# -o: show only processes doing I/O
# -b: batch mode (non-interactive)

# Per-disk I/O breakdown
iostat -x 1 5
# Look at: %util (disk utilization), await (average wait time), r/s, w/s

# What files are being read/written by a specific process
lsof -p $PID | grep REG | head -20
```

**Common cause for Kafka brokers:**

The Kafka broker is doing heavy page cache eviction because the message log exceeds available RAM. Kafka's performance relies on the OS page cache for reads. When the log is larger than RAM, every read requires a disk I/O instead of a cache hit.

Fix: increase instance RAM, reduce log retention, or move to storage-optimized instance types (i3, im4gn) with NVMe SSDs.
