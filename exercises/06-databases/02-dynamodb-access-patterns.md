# Exercise 2 — DynamoDB Schema Design for Bet Tracking

## Scenario

You are designing the DynamoDB schema for Winamax's bet slip tracking system. The system must handle 75,000 events per second during peak (Champions League final). Each bet slip goes through the following states:

```
PENDING → ACCEPTED → SETTLED (won or lost) / CANCELLED / VOIDED
```

---

## Access patterns (given — you must design around these)

1. **Get a specific bet slip** — by bet ID. Most common operation. Used by all downstream services.
2. **Get all open bets for a user** — status = ACCEPTED. Used by the UI (user's "my bets" page).
3. **Get a user's full bet history** — all bets, sorted by date descending. Used by the account page.
4. **Get all PENDING bets older than 5 minutes** — for the settlement watchdog. Runs every 30 seconds.
5. **Get all bets for a specific event** — e.g., all bets placed on match MATCH-001. Used by risk engine.

---

## Task 1: Design the main table

Define the primary key structure for the main `BetSlips` table:

```
Table: BetSlips

Partition key:  ____________________
Sort key:       ____________________ (if needed)

Example item:
{
  "____": "____",  // PK
  "____": "____",  // SK (if applicable)
  "userId": "U-12345",
  "eventId": "MATCH-001",
  "sport": "football",
  "stake": 10.50,
  "status": "PENDING",
  "createdAt": "2024-01-15T14:30:00Z",
  "settledAt": null,
  "odds": 1.85
}
```

Which access patterns does this main table support directly?

---

## Task 2: Design GSIs for remaining access patterns

For each access pattern that the main table cannot serve efficiently, design a GSI:

**GSI 1 — User bets by status and date:**
```
Index name: ____________________
Partition key: ____________________
Sort key: ____________________
Projection: ____________________

Serves access pattern(s): #____, #____
```

**GSI 2 — Event bets:**
```
Index name: ____________________
Partition key: ____________________
Sort key: ____________________
Projection: ____________________

Serves access pattern(s): #____
```

**What about access pattern #4 (PENDING bets older than 5 minutes)?**
Why is this pattern inherently difficult to serve from DynamoDB, and what alternative approach would you use?

---

## Task 3: Partition key hot spot analysis

During a Champions League final, the following write pattern occurs:
- 50,000 new bet slips in the first 5 minutes (kick-off rush)
- All bets on `eventId = MATCH-CL-FINAL-001`
- Bets are placed by 45,000 different users

**Question:** Does any of your keys create a hot partition during this scenario? Explain your reasoning for each key (PK, SK, GSI partition keys).

---

## Task 4: Capacity mode choice

You must choose between On-Demand and Provisioned (with Auto Scaling) for the `BetSlips` table.

Winamax's write pattern:
- Normal hours: 200–500 writes/second
- Sports event start (5 min): 50,000 writes in 5 minutes = ~167 writes/second surge (but much higher at the exact kick-off moment, up to 2,000 writes/second for 30 seconds)
- Dead overnight: < 10 writes/second

**Question:** Which capacity mode do you recommend and why? What are the cost implications?

---

## Task 5: DynamoDB Streams design

The settlement service must be notified when a bet's status changes from `ACCEPTED` to `SETTLED`. Design the stream consumer:

```
BetSlips table (Streams enabled) → Lambda → ?

1. What StreamViewType do you configure and why?
2. What does the Lambda check to identify a status change to SETTLED?
3. What does the Lambda do with the event?
4. What happens if the Lambda fails mid-processing?
```

---

## Answer Key

### Task 1: Main table design

```
Table: BetSlips

Partition key:  betId (String — UUID)
Sort key:       none needed (betId is already unique)

Why betId as PK?
- Access pattern #1 ("get a specific bet") is the most frequent operation.
  Using betId directly gives O(1) GetItem — fastest possible lookup.
- UUIDs distribute uniformly across partitions — no hot spots regardless of load.
- betId is already unique — no sort key needed to guarantee uniqueness.
```

Main table serves: **Access pattern #1 only** (direct GetItem by betId).

### Task 2: GSIs

**GSI 1 — User bet history:**
```
Index name:    UserBetsIndex
Partition key: userId
Sort key:      createdAt (ISO 8601 string — sorts chronologically)
Projection:    INCLUDE [status, stake, sport, odds, eventId]
               (not ALL — avoids projecting large attributes like settlement details)

Serves: #2 (open bets for a user) and #3 (full user bet history)

For #2: Query(UserBetsIndex, userId="U-12345", FilterExpression="status = ACCEPTED")
For #3: Query(UserBetsIndex, userId="U-12345", ScanIndexForward=False)
         (ScanIndexForward=False gives newest-first order)

Note on #2: DynamoDB cannot filter on GSI partition key + a non-key attribute efficiently.
A FilterExpression is applied AFTER reading all items for the user — if a user has 10,000 bets,
DynamoDB reads all 10,000 and then filters to ACCEPTED.

Better design for #2: Add status to the sort key:
  Sort key: status#createdAt  → "ACCEPTED#2024-01-15T14:30:00Z"
  Query with: begins_with(sort_key, "ACCEPTED")
  → Only reads ACCEPTED bets, no scan/filter cost.
```

**GSI 2 — Event bets:**
```
Index name:    EventBetsIndex
Partition key: eventId
Sort key:      createdAt
Projection:    KEYS_ONLY  (risk engine only needs betId to fetch details)

Serves: #5 (all bets for a specific event)
Query(EventBetsIndex, eventId="MATCH-001")
```

**Access pattern #4 (PENDING bets older than 5 minutes):**

This is a global scan pattern — "give me all items across all partitions where status=PENDING and age>5min." DynamoDB cannot do this efficiently — a `Scan` with FilterExpression reads every partition.

**Better approaches:**
- **DynamoDB Streams → Lambda queue:** When a bet is created, push its betId to an SQS queue with a 5-minute `DelaySeconds`. The settlement watchdog processes the queue — items arrive automatically after 5 minutes, no polling needed.
- **Separate settlement tracking table:** A small table keyed by minute bucket: `PK=2024-01-15T14:30`, `items=[betId1, betId2, ...]`. The watchdog queries this table by the time bucket "5 minutes ago."
- **DynamoDB TTL + Streams:** Set TTL on PENDING bets = createdAt + 5 minutes. When TTL fires, it generates a DELETE stream event. The settlement watchdog consumes the stream, sees a DELETE on a PENDING bet, and triggers settlement check. (Hacky but works.)

### Task 3: Hot partition analysis

```
Main table PK: betId (UUID)
→ 50,000 different UUIDs → 50,000 different partitions → NO hot spot.

GSI 1 PK: userId
→ 45,000 different users → 45,000 different partitions → NO hot spot.
→ (Would be a problem if 50,000 bets came from one user)

GSI 2 PK: eventId = "MATCH-CL-FINAL-001"
→ ALL 50,000 bets go to ONE partition key → HOT PARTITION ALERT.
→ All writes AND reads for this event hit a single shard.
→ At 50,000 writes in 5 min = ~167 WCUs/second — DynamoDB's per-partition limit
  is 3,000 RCUs and 1,000 WCUs, so this is within limits.
→ But if the odds engine also reads this GSI heavily for risk calculations during the match:
  50,000 writes + 10,000 reads/second on one partition = potential throttling.

Mitigation for GSI 2: Write sharding on eventId.
eventId = "MATCH-CL-FINAL-001#" + str(random.randint(0, 9))
Distribute across 10 virtual partitions. Risk engine queries all 10 and merges.
```

### Task 4: Capacity mode

**Recommendation: On-Demand**

Reasoning:
- The spike from 10 writes/second (overnight) to 2,000 writes/second (kick-off) is a 200x increase in 30 seconds.
- Auto Scaling reacts to sustained CloudWatch metrics — it takes 1–2 minutes to scale up provisioned capacity. By then, the kick-off rush is over.
- Provisioned + Auto Scaling optimizes for gradual scaling, not instantaneous spikes.
- On-demand handles any burst immediately at ~1.25× the cost per WCU vs provisioned.

**Cost calculation:**
- 900,000 bets/day × 1 WCU/bet = 900,000 WCUs/day
- On-demand: $1.25 per million WCUs → $1.13/day → ~$34/month
- This is negligible compared to Aurora or Redshift costs at Winamax's scale.
- If the table stabilizes and traffic becomes more predictable, revisit provisioned with overrides for match windows.

### Task 5: DynamoDB Streams design

```
1. StreamViewType: NEW_AND_OLD_IMAGES
   Reason: We need to compare status before and after the change.
   OLD_IMAGE.status = "ACCEPTED" AND NEW_IMAGE.status = "SETTLED"
   tells us this is a status transition, not a new record or an unrelated update.

2. Lambda check:
   if event['eventName'] == 'MODIFY':
       old_status = event['dynamodb']['OldImage']['status']['S']
       new_status = event['dynamodb']['NewImage']['status']['S']
       if old_status == 'ACCEPTED' and new_status == 'SETTLED':
           process_settlement(event['dynamodb']['NewImage'])

3. Lambda actions on settlement:
   - Calculate payout (stake × odds if won, 0 if lost)
   - Update user wallet balance in DynamoDB (transactional with bet record)
   - Send notification to user (SNS/SES)
   - Write audit record to S3 via Kinesis Firehose
   - Publish SettlementCompleted event to Kafka for downstream services

4. Lambda failure handling:
   - Lambda retries failed stream records automatically (up to bisection retry).
   - Set a dead-letter queue (SQS DLQ) on the Lambda event source mapping.
   - Failed records go to DLQ after max retry attempts.
   - Alert on DLQ message count — if settlement processing fails,
     user wallets are not updated → priority P1 incident.
   - Idempotency is critical: if Lambda processes the same event twice,
     it must not double-pay. Use betId as idempotency key when updating the wallet.
```
