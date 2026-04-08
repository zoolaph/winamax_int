# Exercise 3 — Event-Driven Idempotency at Winamax Scale

## Scenario

Winamax processes `bet.settled` events from Kafka. Each event contains:
```json
{
  "event_id": "settle-88991234-1712500100",
  "bet_id": "88991234",
  "user_id": "456",
  "outcome": "WIN",
  "payout_amount": 47.50,
  "settled_at": "2024-04-07T21:30:00Z"
}
```

The settlement consumer must:
1. Mark the bet as settled in Aurora (`bets` table)
2. Credit the user's wallet in Aurora (`wallets` table)
3. Push a notification to the user (via SNS)

This runs on a Kafka consumer group `settlement-processor` with 5 consumer instances. The topic has 20 partitions.

**Key constraint:** This is financial data. Double-crediting a user's wallet or double-settling a bet is a P0 incident.

---

## Task 1: Identify the failure modes

List the specific failure scenarios that could cause a `bet.settled` event to be processed more than once:

```
Scenario 1: ____________________
Scenario 2: ____________________
Scenario 3: ____________________
```

---

## Task 2: Idempotency at the database level

Design the SQL schema and the settlement logic so that double-processing is impossible at the database level, without using Redis.

```sql
-- Schema: add idempotency protection to the bets table
ALTER TABLE bets ADD COLUMN ____________________

-- Schema: add idempotency protection to wallet credits
CREATE TABLE wallet_transactions (
    ____________________
);

-- Settlement logic (pseudo-SQL)
BEGIN TRANSACTION;

  -- Step 1: Mark bet as settled (idempotent)
  ____________________

  -- Step 2: Credit wallet (idempotent)
  ____________________

COMMIT;
```

---

## Task 3: Handling the notification step

The SNS notification (Step 3) does not have database-level idempotency. SNS is external — you cannot use a unique constraint to prevent double-sends.

Question: Should you send the SNS notification inside the transaction, or after committing? Explain the trade-off.

```
Answer:
____________________
```

Write the code structure for safe notification delivery:

```python
def process_settlement(event: dict, db, sns):
    bet_id = event["bet_id"]
    
    # Database transaction (idempotent)
    with db.transaction():
        settled = ____________________
        if not settled:
            return  # Already processed — skip notification too?
        ____________________
    
    # Notification (at-least-once, not idempotent)
    ____________________
```

---

## Task 4: Ordering problem

During a Champions League match, a user places a bet, then immediately cancels it (within the 30-second cancellation window). Two events are produced:

- `bet.placed` with `event_id: place-99887766-1712500200`
- `bet.cancelled` with `event_id: cancel-99887766-1712500210`

Both events use `bet_id=99887766` as the Kafka partition key, so they go to the same partition in the correct order.

**Problem:** A downstream consumer that handles both event types crashes and restarts. Its committed offset is before both events. It reprocesses `bet.placed` first — which is fine. Then it processes `bet.cancelled` — which is fine. But due to a rare network partition, it processes `bet.placed` a second time (after `bet.cancelled`).

What is the result? How do you prevent it?

```
Result of double-processing bet.placed after bet.cancelled:
____________________

Prevention strategy:
____________________
```

---

## Task 5: Dead letter queue design

Design the DLQ flow for the settlement processor. Answer:
1. After how many failures does an event go to the DLQ?
2. What distinguishes a retryable from a non-retryable error?
3. Who is responsible for monitoring and replaying the DLQ, and how?

```
Number of retries before DLQ:
____________________

Retryable error examples:
____________________

Non-retryable error examples:
____________________

DLQ monitoring and replay process:
____________________
```

---

## Answer Key

### Task 1: Failure modes for double-processing

```
Scenario 1: Consumer processes event and credits wallet, but crashes before committing 
the Kafka offset. Kafka redelivers the event. A different consumer processes it again.

Scenario 2: Producer-side retry: the Kafka producer times out on the `bet.settled` event 
acknowledgment and retries, producing two identical messages with the same business data 
but different Kafka message IDs. Both are delivered to consumers.

Scenario 3: DLQ replay: after a bug is fixed, an SRE replays events from the DLQ. Some 
of those events were actually processed successfully — they were in the DLQ due to a 
monitoring error or the consuming service was unavailable temporarily.
```

### Task 2: Database-level idempotency

```sql
-- Bets table: only one settled_event_id per bet
ALTER TABLE bets ADD COLUMN settled_event_id VARCHAR(100) UNIQUE;

-- Wallet transactions: deduplicate by event_id
CREATE TABLE wallet_transactions (
    transaction_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id       VARCHAR(100) NOT NULL UNIQUE,  -- idempotency key
    user_id        BIGINT NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    type           ENUM('credit', 'debit') NOT NULL,
    created_at     TIMESTAMP DEFAULT NOW(),
    INDEX idx_user_id (user_id)
);

-- Settlement logic
BEGIN TRANSACTION;

  -- Step 1: Mark bet as settled — fails silently on duplicate (ON DUPLICATE KEY)
  INSERT INTO bets (bet_id, status, outcome, settled_event_id)
  VALUES ('88991234', 'settled', 'WIN', 'settle-88991234-1712500100')
  ON DUPLICATE KEY UPDATE 
    settled_event_id = IF(settled_event_id IS NULL, VALUES(settled_event_id), settled_event_id);
  -- If settled_event_id was already set, no update occurs.

  -- Better: explicit check
  UPDATE bets 
  SET status = 'settled', outcome = 'WIN', settled_event_id = 'settle-88991234-1712500100'
  WHERE bet_id = '88991234' AND settled_event_id IS NULL;
  -- affected_rows = 0 means already settled → rollback and return

  -- Step 2: Credit wallet — unique constraint on event_id rejects duplicates
  INSERT INTO wallet_transactions (event_id, user_id, amount, type)
  VALUES ('settle-88991234-1712500100', '456', 47.50, 'credit');
  -- Duplicate key error if already processed

COMMIT;
```

### Task 3: Notification after commit

**Answer:** Send the notification **after** committing the transaction, not inside it.

If you send SNS inside the transaction: the transaction holds a DB lock while waiting for the SNS API call (network round trip). A slow or failed SNS call increases lock contention and can cause timeouts. If SNS succeeds but the commit then fails, the user gets a notification for a settlement that did not happen — worse than sending it twice.

If you send after commit: the worst case is the consumer crashes after committing but before sending the notification. The user is settled and credited but not notified. This is recoverable — a retry or a job that checks for settled bets without notifications can fix it. Double-crediting is not recoverable without compensating transactions.

```python
def process_settlement(event: dict, db, sns):
    bet_id = event["bet_id"]
    event_id = event["event_id"]
    
    with db.transaction():
        rows_affected = db.execute(
            "UPDATE bets SET status = 'settled', outcome = %s, settled_event_id = %s "
            "WHERE bet_id = %s AND settled_event_id IS NULL",
            event["outcome"], event_id, bet_id
        )
        if rows_affected == 0:
            return  # Already processed — idempotent exit, no notification needed
        
        db.execute(
            "INSERT INTO wallet_transactions (event_id, user_id, amount, type) "
            "VALUES (%s, %s, %s, 'credit')",
            event_id, event["user_id"], event["payout_amount"]
        )
    
    # Notification after commit — at-least-once is acceptable for notifications
    try:
        sns.publish(
            TopicArn=USER_NOTIFICATION_TOPIC,
            Message=json.dumps({"userId": event["user_id"], "betId": bet_id, "outcome": event["outcome"]}),
            MessageAttributes={"eventId": {"DataType": "String", "StringValue": event_id}}
        )
    except Exception as e:
        logger.error(f"Failed to send notification for {event_id}: {e}")
        # Do not re-raise — the financial side is committed. Notification failure is non-critical.
        # A separate alerting check can catch users with settled bets but missing notifications.
```

### Task 4: Ordering problem

```
Result of double-processing bet.placed after bet.cancelled:
The bet is re-opened (status reset to 'pending'). If the user cannot cancel again
(since it is "new"), they are now in a state where they have a bet they cancelled,
with no way to cancel again. The wallet was debited twice (once on original placement,
once on the reprocessed placement), and the cancellation credit may not fire again.
This is a P0 financial incident.

Prevention strategy:
Use a database state machine with strict allowed transitions:

  pending → cancelled: allowed
  pending → settled: allowed  
  cancelled → pending: NOT ALLOWED
  settled → pending: NOT ALLOWED

In SQL:
  UPDATE bets SET status = 'pending', event_id = 'place-99887766-1712500200'
  WHERE bet_id = '99887766' 
    AND status NOT IN ('cancelled', 'settled')  -- guard clause
    AND event_id IS NULL;                        -- idempotency key not yet set

  If rows_affected = 0 and status is 'cancelled' or 'settled', the duplicate
  bet.placed event is safely ignored because the state machine rejects the
  backwards transition.
```

### Task 5: DLQ design

```
Number of retries before DLQ:
3 retries with exponential backoff (100ms, 1s, 10s). After 3 failures, route to DLQ
and commit the offset. The 3-retry policy is a balance: transient network failures
resolve within 1-2 retries; persistent errors (bad data, downstream down) should
not block the consumer partition for minutes.

Retryable error examples:
- Aurora connection timeout or deadlock (wait and retry)
- SNS API throttling (exponential backoff)
- Wallet service temporarily unavailable (circuit breaker / retry)
- Redis connection error during idempotency check (retry)

Non-retryable error examples:
- bet_id does not exist in Aurora (data integrity error — retrying will always fail)
- event_id format invalid (malformed event — not fixable by retry)
- Payout amount is negative (business rule violation)
- User account is frozen (business rule — will not change on retry)

DLQ monitoring and replay process:
- SRE alert: DLQ depth > 0 is a P2 alert (SRE to investigate within 30 minutes)
- DLQ depth > 100 is P1 (immediate response — financial events are potentially lost)
- Investigation: read DLQ messages, identify error pattern
- Fix: deploy code fix or restore downstream service
- Replay: re-publish DLQ messages to the original topic after fix is confirmed
  using a Kafka consumer that reads bet-events-dlq and produces to bet-events.
  This triggers reprocessing. Idempotency logic handles events that were partially
  processed before going to DLQ.
- Sign-off: confirm DLQ is empty and affected bets have correct status in Aurora.
```
