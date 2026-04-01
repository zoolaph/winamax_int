# Jaeger + Quickwit — Trace and Log Storage at Scale

---

## Jaeger architecture

Jaeger is the open-source distributed tracing backend that Winamax uses. It has two main components:

```
                    ┌──────────────────────────────────────────┐
OTel Collector ────►│  jaeger-collector                        │
(OTLP gRPC)        │  - Receives spans (OTLP or Jaeger format) │
                   │  - Validates and indexes                   │
                   │  - Writes to storage backend              │
                   └──────────────┬───────────────────────────┘
                                  │
                         ┌────────▼────────┐
                         │  Storage backend │
                         │  (Cassandra, ES, │
                         │  object storage) │
                         └────────┬────────┘
                                  │
                   ┌──────────────▼───────────────────────────┐
Grafana ──────────►│  jaeger-query                             │
                   │  - Serves the Jaeger UI                   │
                   │  - REST/gRPC query API                    │
                   │  - Used by Grafana Jaeger data source     │
                   └──────────────────────────────────────────┘
```

---

## The storage problem — why object storage

### The numbers

At Winamax:
- 700+ microservices
- Each request creates ~10-50 spans
- With tail sampling at 5%: still thousands of traces/second retained

```
Rough calculation:
  75,000 Kafka msg/sec → say 10,000 HTTP requests/sec across all services
  × 5% sampling = 500 complete traces/sec retained
  × 20 spans/trace = 10,000 spans/sec
  × 2KB/span average = 20 MB/sec
  × 86,400 sec/day = ~1.7 TB/day of trace data
```

Even with heavy sampling, you generate terabytes of trace data per day. Storage choice is a cost and operability decision.

### Storage backend comparison

| Backend | Pros | Cons | Winamax fit? |
|---|---|---|---|
| **Cassandra** | High write throughput, proven at scale | Complex to operate, expensive disk | Possible |
| **Elasticsearch** | Good query flexibility | Very expensive at TB scale, shard management overhead | Too expensive |
| **Object storage (S3)** | Extremely cheap ($0.023/GB/month), unlimited scale | Query latency (seconds for old data) | **Best fit** |
| **BadgerDB (embedded)** | Simple, no external dependency | Not production-grade for this scale | Dev/test only |

### Why object storage is the right answer for Winamax

Winamax's observability requirements:
1. Self-hosted (no SaaS)
2. Cost-effective at TB/day scale
3. Recent traces queryable quickly (debugging active incidents)
4. Old traces acceptable with seconds of latency (post-mortems)

Object storage (S3) solves all four. This is exactly the Quickwit and Jaeger+object storage use case.

---

## Jaeger with object storage (Badger → S3)

Jaeger's v2 supports object storage via the `jaeger-v2` binary with pluggable backends. The typical open-source pattern is:

```yaml
# jaeger-v2 config with object storage
service:
  extensions: [jaeger_storage, jaeger_query]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [jaeger_storage_exporter]

extensions:
  jaeger_storage:
    backends:
      some_storage:
        elasticsearch:  # or use a community object-storage backend
          # Alternatively: use Tempo (Grafana) which has native S3 support

jaeger_query:
  storage:
    traces: some_storage
  ui:
    config_file: /etc/jaeger/ui-config.json
```

In practice, many teams pair Jaeger UI with **Grafana Tempo** as the storage backend (Tempo natively stores traces on S3). Winamax may use this pattern — the Devoxx talk mentioned their full OTel stack, and Tempo is the standard open-source answer to "trace storage on object storage."

---

## Quickwit — log indexing on object storage

### What Quickwit is

Quickwit is a log search engine built to index and query log data directly on object storage (S3). It is the open-source alternative to Elasticsearch for log workloads.

```
Elasticsearch approach:
  Logs → Elasticsearch indices on attached SSD → search queries hit SSD
  Fast queries, expensive storage, complex shard management

Quickwit approach:
  Logs → Quickwit indexes on S3 → search queries fetch index from S3
  Slightly slower queries, cheap storage, no shard management
```

### Architecture

```
OTel Collector
(logs pipeline)
      │ OTLP
      ▼
┌─────────────────┐
│ quickwit-indexer│  ← receives logs, builds search index segments
│                 │
│ Writes index    │
│ to S3           │
└─────┬───────────┘
      │ S3
      ▼
┌─────────────────┐
│   S3 / S3-compat│  ← cheap, durable, unlimited storage
│                 │
└─────┬───────────┘
      │
      ▼
┌─────────────────┐
│ quickwit-searcher│  ← fetches index from S3, executes queries
│                 │
│ Serves API      │
└─────────────────┘
      │ REST API / gRPC
      ▼
  Grafana (Quickwit data source plugin)
```

### Quickwit vs Elasticsearch for Winamax

| | Quickwit | Elasticsearch |
|---|---|---|
| Storage cost (1TB logs) | ~$23/month (S3) | ~$200-400/month (SSD-backed) |
| Query latency (recent data) | < 1 second | < 100ms |
| Query latency (1 week old) | 1-3 seconds | < 100ms |
| Operational complexity | Low — S3 manages durability | High — shard management, rebalancing |
| GDPR/data locality | S3 in eu-west-1 | Same |
| Self-hosted | Yes | Yes |

For Winamax's self-hosted requirement and data volume, the cost difference is decisive. Elasticsearch at their scale would be a dedicated ops problem. Quickwit on S3 is near zero-ops.

### Quickwit index configuration

Quickwit requires an index configuration that defines the schema for your log fields:

```yaml
# quickwit-index-config.yaml
version: 0.7

index_id: winamax-logs

doc_mapping:
  mode: dynamic            # accept any fields not explicitly mapped
  field_mappings:
    - name: timestamp
      type: datetime
      input_formats: [rfc3339, unix_timestamp]
      fast: true           # enables time-range filtering
    - name: service_name
      type: text
      tokenizer: raw       # exact match (no tokenization)
      fast: true           # enables fast field queries
    - name: level
      type: text
      tokenizer: raw
      fast: true
    - name: trace_id
      type: text
      tokenizer: raw       # exact match — used for trace correlation
      fast: true
    - name: span_id
      type: text
      tokenizer: raw
    - name: message
      type: text
      tokenizer: default   # full-text search

indexing_settings:
  timestamp_field: timestamp

search_settings:
  default_search_fields: [message, event]
```

### Querying Quickwit from Grafana

Quickwit supports a subset of Elasticsearch query syntax (so the Grafana Elasticsearch data source works) and has its own REST API:

```
# Find all errors for betting-api in the last hour
service_name:betting-api AND level:ERROR

# Find logs correlated to a specific trace
trace_id:7d3f2a1b4e5c6d7e8f9a0b1c2d3e4f50

# Find bet validation failures with duration > 100ms
event:bet_validation_failed AND duration_ms:>100
```

---

## Retention policies — operational reality

"Terabytes of traces on object storage" also means decisions about retention:

```
Hot storage (recent, fast query):
  Quickwit/Jaeger keep last 7-14 days in accessible index
  S3 Standard tier: $0.023/GB/month

Warm storage (access for post-mortems, slower queries):
  30-90 days in S3 Standard-IA (infrequent access): $0.0125/GB/month

Cold storage (compliance, auditing):
  1 year in S3 Glacier: $0.004/GB/month
  Query requires restore (hours)

Deletion:
  S3 lifecycle rules delete objects after retention period
```

```python
# Example S3 lifecycle rule (Terraform)
resource "aws_s3_bucket_lifecycle_configuration" "traces" {
  bucket = aws_s3_bucket.traces.id

  rule {
    id     = "traces-retention"
    status = "Enabled"

    transition {
      days          = 14
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }
}
```

For GDPR compliance: player data must not persist beyond the retention period. If trace data contains player IDs, the retention period must align with GDPR data retention requirements.

---

## The operational answer for an interview

**Q: "What does 'terabytes of traces on object storage' mean operationally for your team?"**

A: It means we store traces in S3 via Quickwit rather than running a large Elasticsearch or Cassandra cluster. The trade-off is query latency — recent traces (last 24 hours) are fast, older traces take 1-3 seconds. That is acceptable for incident debugging. What we get in return is dramatically lower cost, near-zero operational overhead on the storage layer, and unlimited scale. We define retention tiers: recent data in S3 Standard, older data transitions to Infrequent Access, deletes after the GDPR retention period. The SRE team manages the Quickwit and Jaeger services but not the storage durability — S3 handles that. The operational concern is the query service availability (Quickwit searcher, Jaeger query) and the write pipeline (OTel Collector → indexer) not the storage itself.
