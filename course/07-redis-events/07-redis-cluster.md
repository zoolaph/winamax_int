# Redis Cluster — Deep Dive

ElastiCache with cluster mode enabled is how Winamax runs Redis at scale. Understanding cluster topology, hash slots, failover, and the operational constraints that come with cluster mode is expected depth for an SRE role.

---

## Hash slots — how data is distributed

Redis Cluster divides the keyspace into **16,384 hash slots**. Every key is assigned to a slot using CRC16:

```
slot = CRC16(key) % 16384
```

Each primary node owns a contiguous range of slots. With 3 primary nodes:
- Node A: slots 0–5460
- Node B: slots 5461–10922
- Node C: slots 10923–16383

When you `SET user:456:session`, Redis computes the slot, routes the command to the node that owns that slot. If you connect to the wrong node, it returns a `MOVED` redirect:

```
MOVED 7638 redis-node-b:6379
```

Smart clients (Jedis, StackExchange.Redis, redis-py) follow `MOVED` redirects automatically and cache the slot map. Dumb clients break.

---

## Hash tags — co-locating related keys

A critical operational requirement: multi-key commands (`MGET`, `MSET`, `SUNION`, Lua scripts) only work if all keys are on the same slot.

Without hash tags:
```redis
MGET user:456:session user:456:cart user:456:preferences
# ERROR: keys on different slots — CROSSSLOT error
```

With hash tags — the part inside `{}` is used for slot calculation, ignoring the rest:
```redis
MGET {user:456}:session {user:456}:cart {user:456}:preferences
# All three hash to the same slot (slot of "user:456")
# → works in cluster mode
```

**Rule:** Always use hash tags for keys that must be accessed together in multi-key operations. At Winamax, all per-user Casino state keys should use `{userId}` as the hash tag.

---

## Cluster topology — primary, replica, quorum

Each primary node has one or more replica nodes. The recommended ElastiCache configuration for production:

```
Cluster mode enabled
Shards: 3 (or more based on memory + throughput)
Replicas per shard: 2

Node group 0: primary-0a (eu-west-3a), replica-0b (eu-west-3b), replica-0c (eu-west-3c)
Node group 1: primary-1b (eu-west-3b), replica-1a (eu-west-3a), replica-1c (eu-west-3c)
Node group 2: primary-2c (eu-west-3c), replica-2a (eu-west-3a), replica-2b (eu-west-3b)
```

Spreading primaries and replicas across AZs ensures that losing an entire AZ only takes down one primary, which immediately fails over to a replica in a surviving AZ.

---

## Failover mechanics

When a primary node fails, the cluster uses a gossip protocol to detect it:

1. Other nodes mark the primary as `PFAIL` (possible fail) after `cluster-node-timeout` milliseconds (default: 15 seconds)
2. If a quorum of masters agree the node is down, it becomes `FAIL`
3. The replicas of the failed primary hold an election — the one with the most replication data becomes the new primary
4. The cluster updates its slot map and starts routing commands to the new primary

**Total failover time:** ~15–30 seconds for ElastiCache cluster mode.

**During failover:** Commands to the affected slots return errors. Your application must handle these errors gracefully — retry with backoff, not hard fail.

```python
from redis.exceptions import ConnectionError, ResponseError
import time

def redis_set_with_retry(redis, key, value, ttl, max_retries=3):
    for attempt in range(max_retries):
        try:
            return redis.setex(key, ttl, value)
        except (ConnectionError, ResponseError) as e:
            if attempt == max_retries - 1:
                raise
            time.sleep(0.1 * (2 ** attempt))  # Exponential backoff: 100ms, 200ms, 400ms
```

---

## ElastiCache cluster mode — configuration specifics

### Cluster mode enabled

- Multiple shards, each with its own hash slot range
- Horizontal scaling: add shards to increase write throughput (each shard handles a fraction of the keyspace)
- Cannot resize (add/remove shards) without a brief interruption (ElastiCache does online resharding but it is not instant)
- Multi-AZ failover happens independently per shard

### Cluster mode disabled

- Single primary + N read replicas (all replicas hold the full dataset)
- No hash slot concept — all commands go to the primary (or replicas for reads)
- Simpler: standard Redis client, no hash tag requirements
- Write throughput limited to one node
- Read scaling: distribute reads across replicas

**Winamax recommendation:** Cluster mode enabled for production caches that need horizontal write scaling or whose dataset exceeds the memory of a single node. Cluster mode disabled for smaller, simpler caches where operational simplicity matters.

---

## Resharding — adding capacity

In ElastiCache cluster mode, you can add shards online:

```
Before: 3 shards (0–5460, 5461–10922, 10923–16383)
After adding shard 3: 4 shards (re-distributed across all 4)
```

During resharding, ElastiCache migrates slots between nodes. Keys are served from the source node until the migration is complete, then from the destination. The client receives `MOVED` redirects and follows them. There is no downtime, but there is a latency blip (~milliseconds per key) as slot ownership changes.

**Terraform for ElastiCache cluster mode:**
```hcl
resource "aws_elasticache_replication_group" "winamax_cache" {
  replication_group_id          = "winamax-prod-cache"
  description                   = "Production Redis cache"
  node_type                     = "cache.r7g.large"
  num_node_groups               = 3        # Shards (cluster mode enabled)
  replicas_per_node_group       = 2        # Replicas per shard
  automatic_failover_enabled    = true
  multi_az_enabled              = true
  at_rest_encryption_enabled    = true
  transit_encryption_enabled    = true
  
  parameter_group_name          = aws_elasticache_parameter_group.redis_cluster.name
  subnet_group_name             = aws_elasticache_subnet_group.cache.name
}

resource "aws_elasticache_parameter_group" "redis_cluster" {
  family = "redis7"
  name   = "winamax-redis-params"
  
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lfu"
  }
  
  parameter {
    name  = "cluster-enabled"
    value = "yes"
  }
}
```

---

## Monitoring checklist

| Metric | What it indicates | Alert threshold |
|--------|------------------|-----------------|
| `CacheHits` / `CacheMisses` | Cache effectiveness | Hit rate < 90% |
| `Evictions` | Memory pressure, TTL too long | > 0 and growing |
| `CurrConnections` | Connection pool health | > 80% of max |
| `ReplicationLag` | Replica freshness | > 100ms |
| `EngineCPUUtilization` | Hot slot or hot key | > 80% |
| `DatabaseMemoryUsagePercentage` | Memory headroom | > 80% → scale up |
| `CacheHitRate` | (ElastiCache metric) | < 0.9 → investigate |

**Hot key detection:**
```bash
# On the Redis node
redis-cli --hotkeys -u redis://primary-node:6379
# Or with keyspace notifications — monitor which keys receive the most commands
redis-cli monitor | grep GET | awk '{print $4}' | sort | uniq -c | sort -rn | head -20
```

A hot key is one that receives a disproportionate fraction of all commands. In cluster mode, a hot key concentrates all traffic on one shard's primary, while other shards idle. The fix: split the hot key into N variants and randomly distribute reads across them (`odds:match:789:shard:0` through `odds:match:789:shard:7`).

---

## K8s bridge

Redis Cluster's slot-based routing is similar to how Kubernetes routes traffic based on Service selectors — but instead of label matching, it is hash-based key affinity. The `MOVED` redirect is like a Kubernetes `Service` that re-routes you to the correct pod. The cluster topology map (which node owns which slots) is like the Kubernetes endpoint slice that maps services to pod IPs.

A Redis Cluster primary promotion after failure is the same pattern as a Kubernetes leader election for a StatefulSet — replicas run a Raft-like election, the one with the most current data wins, and the cluster converges on the new topology.
