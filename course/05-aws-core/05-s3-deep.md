# S3 — Deep Dive

## What S3 is

S3 (Simple Storage Service) is AWS's object store. Objects are stored in buckets. Each object has:
- A key (the full "path", e.g., `traces/2026/04/01/service-api/trace-123.json`)
- Data (arbitrary bytes, up to 5TB per object)
- Metadata (content-type, custom tags, etc.)
- Access control

S3 is not a filesystem. There are no real directories — the key is just a string with slashes that tools use to simulate folder structure.

---

## Buckets

A bucket is a globally unique namespace container in a specific AWS region.

```
s3://winamax-traces-prod/
  traces/2026/04/01/service-api/...
  traces/2026/04/01/service-payments/...
  logs/2026/04/01/ecs/...
```

**Block Public Access** — a separate account-level and bucket-level setting that prevents any public access, even if a bucket policy would otherwise allow it. Enable this on all buckets unless you explicitly need public access (static website hosting). This is a guardrail, not an ACL.

---

## Access control

### Bucket policy

A resource-based policy attached to the bucket. Specifies who can do what.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/ecs-task-role-observability"
      },
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::winamax-traces-prod/traces/*"
    },
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::winamax-static-prod/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/EXXX"
        }
      }
    }
  ]
}
```

### ACLs

Legacy access control mechanism. Avoid for new buckets — use bucket policies instead. AWS recommends disabling ACLs entirely (`ObjectOwnership: BucketOwnerEnforced`).

---

## Storage classes

S3 has multiple storage classes with different cost/availability/retrieval tradeoffs.

| Class | Use case | Retrieval | Cost (relative) |
|--|--|--|--|
| S3 Standard | Frequently accessed data | Immediate | $$$ |
| S3 Standard-IA | Infrequent access (>30 days) | Immediate | $$ |
| S3 One Zone-IA | Infrequent, can rebuild if AZ lost | Immediate | $ |
| S3 Glacier Instant Retrieval | Archives accessed occasionally | Milliseconds | $0.5 |
| S3 Glacier Flexible Retrieval | Archives, minutes-to-hours retrieval | Minutes/hours | $0.25 |
| S3 Glacier Deep Archive | Long-term regulatory storage | 12 hours | $0.1 |
| S3 Intelligent-Tiering | Unknown/changing access patterns | Immediate | $$ + monitoring fee |

---

## Lifecycle rules

Lifecycle rules automate transition between storage classes and deletion.

```
Bucket: winamax-traces-prod

Lifecycle rule: traces-archival
  Filter: prefix = traces/
  
  Transitions:
    After 30 days  → S3 Standard-IA
    After 90 days  → S3 Glacier Instant Retrieval
    After 365 days → S3 Glacier Deep Archive
  
  Expiration:
    After 2555 days (7 years) → delete object
```

For Winamax's observability stack, this is how they manage cost:
- Recent traces (last 30 days): S3 Standard — fast access for debugging
- Older traces: Glacier — rarely accessed, huge cost saving
- Legal/compliance data: Glacier Deep Archive until regulatory retention period expires

---

## Versioning

Versioning keeps all versions of an object on every put/overwrite/delete. Deleted objects get a "delete marker" instead of being removed.

Use cases:
- Protection against accidental deletion or overwrite
- Required by some compliance frameworks
- MFA Delete: require MFA to delete versions (ransomware protection)

Cost: you pay for every version stored. Use lifecycle rules to expire old versions:
```
After 90 days → permanently delete non-current versions
```

---

## S3 as observability backend (Winamax pattern)

Winamax uses Quickwit, an open-source log search engine, with S3 as the backend storage.

```
[ECS Tasks]
    ↓ logs via awslogs driver or OTel Collector
[CloudWatch Logs / OTel Collector]
    ↓ ship to S3
[S3: winamax-logs-prod]
    ↓ indexed by
[Quickwit cluster]
    ↑ queried via
[Grafana (data source: Quickwit)]
```

This architecture decouples storage (S3, cheap and durable) from indexing/querying (Quickwit, fast). You can re-index historical data. You own the data — no SaaS dependency.

Compare to Elasticsearch: Elastic stores data on local disk in the cluster. If you need to query 1TB of logs, you need a large cluster. With S3-backed Quickwit, S3 stores the data cheaply and Quickwit handles indexing — you scale compute and storage independently.

---

## Event notifications

S3 can trigger events when objects are created, deleted, or restored.

Targets: SNS, SQS, Lambda, EventBridge.

```
S3 event: PUT in traces/*
  → SQS queue → Lambda → trigger Quickwit indexing job
```

This is how real-time ingestion works: new log objects in S3 trigger immediate indexing rather than batch polling.

---

## S3 performance

- **Prefix-based parallelism**: S3 has no throughput limit per bucket, but requests per prefix are limited. Distribute objects across many prefixes to maximize throughput.
- **Multipart upload**: for objects > 100MB, use multipart upload for parallelism and resilience. Required for objects > 5GB.
- **S3 Transfer Acceleration**: uses CloudFront edge PoPs to accelerate uploads from clients to S3. Useful for geographically distributed clients uploading large files.

---

## Key facts to remember

- S3 is **eventually consistent** for overwrites in some edge cases historically, but AWS made S3 **strongly consistent** in December 2020. No stale reads after a PUT.
- **Cross-Region Replication (CRR)**: automatically replicate objects to a bucket in another region. Used for DR and compliance.
- **Presigned URLs**: generate a time-limited URL that grants temporary access to a specific object without requiring AWS credentials. Used to give users a download link without making the bucket public.
- **S3 Select**: run SQL queries against CSV/JSON/Parquet objects without downloading the entire file. Useful for querying structured logs.
