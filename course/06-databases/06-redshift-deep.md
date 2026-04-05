# Redshift — Deep Dive

## What Redshift is for

Redshift is a columnar data warehouse designed for analytical queries (OLAP) over large datasets. It is the right tool when you are running queries like:

```sql
-- How much revenue did we generate per sport type in Q4 2024?
SELECT sport_type, SUM(stake_amount) as total_staked, COUNT(*) as bet_count
FROM bet_history
WHERE settled_at BETWEEN '2024-10-01' AND '2024-12-31'
GROUP BY sport_type
ORDER BY total_staked DESC;
```

This query scans millions of rows. In Aurora (row-oriented), the engine reads entire rows and discards most columns. In Redshift (column-oriented), the engine reads only `sport_type`, `stake_amount`, and `settled_at` — exactly what the query needs.

**Winamax use case:** 900,000 bets/day × 365 days = ~330M bet records per year. The business needs reports on revenue, margins, user behavior, and compliance. That is Redshift's domain.

---

## Columnar storage — why it matters

**Row-oriented storage (Aurora/MySQL):**
```
Row 1: [betId=001, userId=U-123, sport=football, amount=10.50, status=SETTLED, timestamp=...]
Row 2: [betId=002, userId=U-456, sport=tennis,   amount=5.00,  status=PENDING, timestamp=...]
```

To answer "total amount by sport", the engine reads every row (including betId, userId, status, timestamp) and discards most of it.

**Columnar storage (Redshift):**
```
sport column:  [football, tennis, football, basketball, ...]
amount column: [10.50, 5.00, 25.00, 8.00, ...]
```

To answer "total amount by sport", the engine reads only 2 columns. For a 50-column table, this is a 25x I/O reduction. Combined with per-column compression (football, football, football → run-length encoded to [football × 3]), storage shrinks dramatically.

---

## Distribution keys — how data is spread across nodes

Redshift is MPP (massively parallel processing) — your data is split across multiple nodes. How it splits determines query performance.

**Distribution styles:**

| Style | How data is distributed | Best for |
|--|--|--|
| `KEY` | All rows with the same key value go to the same node | JOIN-heavy queries — both tables distributed on the join key |
| `ALL` | A full copy of the table on every node | Small dimension tables (lookup data) |
| `EVEN` | Round-robin, no intelligence | Tables that are never joined |
| `AUTO` | Redshift chooses based on table size | Default — good starting point |

**Winamax example:**
```sql
-- bet_history is your fact table (hundreds of millions of rows)
-- events table is a dimension (thousands of rows)
-- You frequently JOIN them on event_id

CREATE TABLE bet_history (
  bet_id     VARCHAR(36),
  user_id    VARCHAR(36),
  event_id   VARCHAR(36),
  stake      DECIMAL(10,2),
  ...
) DISTKEY(event_id);   -- distribute on join key

CREATE TABLE events (
  event_id   VARCHAR(36),
  sport_type VARCHAR(50),
  ...
) DISTSTYLE ALL;       -- small table — copy to all nodes, avoid shuffle
```

When both tables have the same distribution key on the join column, Redshift can join them locally on each node — no network shuffle needed. This is called a **collocated join**.

---

## Sort keys — the index equivalent

Redshift does not have indexes. Sort keys define the physical sort order of data on disk. The query engine uses zone maps (min/max per block) to skip blocks that cannot contain matching rows.

**Single sort key:**
```sql
CREATE TABLE bet_history (
  ...
  settled_at TIMESTAMP
) SORTKEY(settled_at);
```

Query `WHERE settled_at > '2024-01-01'` can skip all blocks with `max(settled_at) < '2024-01-01'`. For time-series data (which most analytics is), this is the most important optimization.

**Compound sort key (multiple columns):**
```sql
SORTKEY(settled_at, sport_type)
```
Effective for queries that filter on both columns in order. Less useful if you only filter by `sport_type` alone.

**Interleaved sort key:** Treats all sort key columns equally. Better for multi-column filters where no column is always queried first. Useful for ad-hoc analytical queries but slower to vacuum.

---

## Workload Management (WLM)

Redshift has limited concurrency (default: 5 queries at a time). WLM lets you define queues with different priorities and concurrency:

```
Queue 1: BI dashboards
  - 3 concurrent queries
  - Memory: 40%
  - Timeout: 120 seconds (auto-cancel runaway queries)

Queue 2: Batch ETL jobs
  - 2 concurrent queries
  - Memory: 60%
  - Timeout: 3600 seconds

Default queue: ad-hoc queries
  - 1 concurrent query
  - Memory: remaining
```

A 10-minute BI query should not block a 100ms dashboard refresh query. WLM separates them.

---

## Redshift Spectrum

Redshift Spectrum lets you query data stored in S3 directly without loading it into Redshift:

```sql
-- Query last 3 years of archived bets directly from S3
SELECT COUNT(*) FROM spectrum.bet_archive
WHERE year = 2021 AND sport = 'football';
```

**Winamax use case:** Bet data older than 1 year is moved from Redshift to S3 (Glacier) as part of the lifecycle policy. Spectrum allows compliance queries against that archived data without restoring it to Redshift storage.

---

## Redshift vs DynamoDB decision matrix

```
Question to ask: "Is this an operational query or an analytical query?"

Operational:   "Get this user's open bets"    → DynamoDB (ms latency, by user key)
Analytical:    "Top 10 most-bet sports today" → Redshift (aggregation, full table scan)

Question: "How often is this data written?"

High frequency: 75k msg/sec bet events        → DynamoDB (designed for this)
Low frequency:  ETL batch loads (hourly/daily) → Redshift (bulk COPY command)

Question: "What is the data size?"

Hundreds of millions of rows, growing daily   → Redshift (columnar compression)
Millions of items, point lookups              → DynamoDB (hash-partitioned)
```

The flow at Winamax:
```
Live bets → DynamoDB (real-time operational)
          ↓ (DynamoDB Streams → Kinesis → S3)
         Redshift (analytics, reporting, BI)
```

---

## VACUUM and ANALYZE

Two maintenance operations you must know:

**VACUUM:** Reclaims space from deleted rows and re-sorts data according to the sort key. DML operations (UPDATE, DELETE) leave deleted rows in place — VACUUM cleans them up.

```sql
VACUUM bet_history;           -- Full vacuum
VACUUM SORT ONLY bet_history; -- Only re-sort, don't reclaim space
VACUUM DELETE ONLY bet_history; -- Only reclaim space, don't re-sort
```

Run VACUUM after large deletes or in a scheduled maintenance window.

**ANALYZE:** Updates table statistics used by the query planner. Without current statistics, the planner makes bad join and filter decisions.

```sql
ANALYZE bet_history;  -- Update statistics
```

Run ANALYZE after bulk data loads.
