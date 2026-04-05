# DynamoDB — Deep Dive

## The mental model shift from SQL

In SQL, you design your schema and then write queries. In DynamoDB, you design your schema **around your queries**. You must know all access patterns before you design the table.

This is not a limitation — it is the source of DynamoDB's performance. Because AWS knows exactly how you will access data, it can guarantee single-digit millisecond latency at any scale by routing each request to the specific partition that holds the data.

---

## Primary keys — the foundation

Every DynamoDB item is uniquely identified by its primary key. There are two types:

**Simple primary key (partition key only):**
```
Table: BetSlips
PK: betId (string)

| betId     | userId  | amount | status  |
|-----------|---------|--------|---------|
| BET-00001 | U-12345 | 10.50  | SETTLED |
| BET-00002 | U-67890 | 5.00   | PENDING |
```
Query: `GetItem(betId="BET-00001")` — direct lookup, O(1).

**Composite primary key (partition key + sort key):**
```
Table: UserBets
PK: userId (partition key)
SK: timestamp#betId (sort key)

| userId  | timestamp#betId              | amount | sport    |
|---------|------------------------------|--------|----------|
| U-12345 | 2024-01-15T14:30:00#BET-001 | 10.50  | football |
| U-12345 | 2024-01-15T16:45:00#BET-002 | 25.00  | tennis   |
| U-67890 | 2024-01-15T14:32:00#BET-003 | 5.00   | football |
```

Queries:
- `GetItem(userId="U-12345", sk="2024-01-15T14:30:00#BET-001")` — exact item.
- `Query(userId="U-12345", sk begins_with "2024-01-15")` — all bets today for this user.
- `Query(userId="U-12345")` — all bets ever for this user, sorted by time.

The sort key is what enables range queries within a partition.

---

## Partition key design — hot partitions are production incidents

**The rule:** write traffic is distributed across partitions by hashing the partition key. If one partition key value is written much more than others, that partition becomes hot and gets throttled.

**Bad design for Winamax:**
```
PK: sport (string)  # "football" during a Champions League final → hot partition
```

**Bad design:**
```
PK: date (string)  # "2024-01-15" → all writes today go to one partition
```

**Good design — spread the load:**
```
PK: betId (UUID)  # Uniform distribution — every bet goes to a different partition
```

Or for user-centric access:
```
PK: userId  # Spreads across users — only hot if one user places thousands of bets/second
SK: timestamp#betId
```

**When you have an unavoidable hot key** (e.g., a counter for total bets placed today):
- Write sharding: add a random suffix to the key (`counter#0`, `counter#1`, ... `counter#9`). Read all 10 and sum in the application.
- Or use DAX (DynamoDB Accelerator) to cache the frequently-read value.

---

## Global Secondary Indexes (GSIs)

A GSI creates an alternate primary key definition on the same table data. DynamoDB maintains the index automatically.

**Example:** You need to look up bets by status (e.g., "find all PENDING bets"):
```
Table: BetSlips
PK: betId

GSI: StatusIndex
  PK: status
  SK: createdAt

# Query: "give me all PENDING bets created after 2024-01-15"
Query on StatusIndex(status="PENDING", sk > "2024-01-15")
```

**GSI limitations:**
- GSIs have their own write capacity (separate from the main table).
- A GSI can only project specific attributes — you can project ALL, KEYS_ONLY, or specific attributes. Projecting ALL costs more storage.
- GSIs do not guarantee strong consistency — they are eventually consistent.

**Rule of thumb:** Design your table schema for the primary access pattern (typically by item ID). Add GSIs for secondary query patterns (by status, by date, by user).

---

## Capacity modes

**On-demand mode:**
- No capacity planning. You pay per request.
- Automatically scales to handle any request rate.
- Cost: higher per-request cost, but no idle capacity cost.
- **Use when:** traffic is unpredictable (sports event spikes), new tables where traffic is unknown, tables that are mostly idle with occasional bursts.

**Provisioned mode:**
- You specify Read Capacity Units (RCUs) and Write Capacity Units (WCUs).
- 1 RCU = 1 strongly consistent read/second (up to 4 KB), or 2 eventually consistent reads/second.
- 1 WCU = 1 write/second (up to 1 KB).
- Can be combined with Auto Scaling to adjust based on CloudWatch metrics.
- **Use when:** traffic is predictable and steady, and you want cost predictability.

**Winamax recommendation:**
- Bet state tables: On-demand. Sports events create 10x spikes in minutes.
- User profile tables: Provisioned + Auto Scaling. Grows with user base, predictable pattern.

---

## DynamoDB Streams

When Streams are enabled, every item change (INSERT, MODIFY, REMOVE) is written to a stream shard. A Lambda function or application can consume the stream.

**Retention:** 24 hours.

**Stream view types:**
- `KEYS_ONLY` — only the item's key attributes.
- `NEW_IMAGE` — the item after the change.
- `OLD_IMAGE` — the item before the change.
- `NEW_AND_OLD_IMAGES` — both. Use this when you need to compare (e.g., audit what changed).

**Winamax use case:**
```
BetSlips table (Stream enabled) →  Lambda →  downstream processing

When a bet status changes from PENDING to SETTLED:
  - Trigger payout calculation Lambda
  - Update aggregate counters
  - Send notification to user
  - Write audit log to S3/Quickwit
```

This is event-driven architecture at the database layer — similar to Kafka but for table-level changes.

---

## Transactions

DynamoDB supports ACID transactions across up to 100 items and 4 MB:

```python
# Example: atomically deduct balance and create bet
dynamodb.transact_write(
    TransactItems=[
        {
            'Update': {
                'TableName': 'UserWallets',
                'Key': {'userId': {'S': 'U-12345'}},
                'UpdateExpression': 'SET balance = balance - :amount',
                'ConditionExpression': 'balance >= :amount',
                'ExpressionAttributeValues': {':amount': {'N': '10.50'}}
            }
        },
        {
            'Put': {
                'TableName': 'BetSlips',
                'Item': {
                    'betId': {'S': 'BET-99999'},
                    'userId': {'S': 'U-12345'},
                    'amount': {'N': '10.50'},
                    'status': {'S': 'PENDING'}
                },
                'ConditionExpression': 'attribute_not_exists(betId)'  # Idempotency check
            }
        }
    ]
)
```

Transactions cost 2x the RCUs/WCUs of non-transactional operations. Use them only when atomicity is required.

---

## DAX — DynamoDB Accelerator

DAX is an in-memory cache for DynamoDB, API-compatible with the DynamoDB SDK. Applications point at DAX instead of DynamoDB; DAX handles cache-aside automatically.

- Read latency: microseconds (vs single-digit milliseconds for DynamoDB).
- Useful when the same items are read very frequently (hot items).
- **Does not help write performance** — writes go through DAX to DynamoDB.

**Winamax use case:** live odds data that many services read simultaneously. The odds for "France vs Germany" might be read 10,000 times/second during a live match. DAX absorbs most of those reads.
