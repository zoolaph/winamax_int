# Event-Driven Design — Idempotency, Ordering, Retry Safety

At 75,000 messages per second, every consumer in Winamax's system will eventually receive a duplicate message, process an event out of order, or crash mid-processing. Designing for these failure modes is not optional — it is the job.

---

## Why events get retried

Both Kafka and Redis Streams use at-least-once delivery. This is intentional: the alternative (at-most-once) loses messages on failure. The trade-off is that the same message may arrive twice:

- Consumer processes event, crashes before committing offset → same event redelivered
- Network timeout causes producer to retry → same event sent twice with different Kafka message IDs
- Dead letter queue reprocessing → old events replayed

**The system must handle duplicates. This is not a special case. It is the normal operational state.**

---

## Idempotency — processing the same event twice must be safe

### Pattern 1: Idempotency key deduplication

Every event carries a globally unique `event_id`. Before processing, check if this ID has been seen.

```python
def process_bet_settled_event(event: dict):
    event_id = event["event_id"]  # e.g., "bet-settled-88991234-1712500100"
    
    # Check if already processed (Redis SET with TTL)
    already_processed = redis.set(
        f"processed:events:{event_id}",
        "1",
        nx=True,      # Only set if not exists
        ex=3600       # 1-hour TTL — events older than 1 hour cannot be duplicates
    )
    
    if not already_processed:
        logger.info(f"Duplicate event {event_id} — skipping")
        return
    
    # First time seeing this event — process it
    settle_bet(event["bet_id"], event["outcome"], event["payout"])
    
    # Acknowledge to Kafka/Redis Streams
    consumer.commit()
```

**TTL on the deduplication key:** Choose based on your redelivery window. If Kafka retention is 7 days and consumer offsets can lag up to 7 days, your deduplication TTL must be at least 7 days. For live betting events, a 1-hour TTL is reasonable (a bet is settled within seconds to minutes).

### Pattern 2: Database-level idempotency (optimistic)

Use a unique constraint in the database as the idempotency gate.

```sql
CREATE TABLE bet_settlements (
    bet_id VARCHAR(36) PRIMARY KEY,
    outcome VARCHAR(20) NOT NULL,
    payout DECIMAL(10,2) NOT NULL,
    settled_at TIMESTAMP DEFAULT NOW()
);
```

```python
def settle_bet(bet_id: str, outcome: str, payout: float):
    try:
        db.execute(
            "INSERT INTO bet_settlements (bet_id, outcome, payout) VALUES (%s, %s, %s)",
            bet_id, outcome, payout
        )
    except IntegrityError:
        # Duplicate key — already settled, safe to ignore
        logger.info(f"Bet {bet_id} already settled — duplicate event")
```

**Advantage:** No Redis dependency for idempotency. The database is the source of truth.
**Disadvantage:** More DB load — every event requires a write attempt to Aurora.

### Pattern 3: Conditional updates (check-and-set)

Only apply the state change if the entity is in the expected state.

```python
def place_bet(bet_id: str, amount: float):
    # Only create if bet does not already exist
    rows_affected = db.execute(
        "INSERT INTO bets (bet_id, amount, status) VALUES (%s, %s, 'pending') "
        "ON DUPLICATE KEY UPDATE bet_id = bet_id",  # No-op on duplicate
        bet_id, amount
    )
    # rows_affected = 1 on first insert, 0 on duplicate — both are safe
```

---

## Ordering — when sequence matters

### Kafka ordering guarantee

Kafka guarantees ordering **within a partition**. All events for the same entity must go to the same partition.

**Problem:** If bet events for `bet_id=88991234` go to partition 3, and settlement events for the same bet also go to partition 3, the consumer processes them in the correct order. But if they end up on different partitions, a settlement event could arrive before the bet placement event.

**Solution:** Use a consistent partition key.

```python
producer.send(
    topic="bet-events",
    key=bet_id.encode(),    # Same betId always → same partition
    value=event_json
)
```

**Partition-level ordering is sufficient** for most Winamax use cases: all events for a specific bet, user session, or casino hand go to the same partition. Events for different entities can be processed in parallel.

### Redis Streams ordering

Redis Streams maintain strict insertion order within a single stream. Consumer groups partition work by message — not by key — so two consumers in the same group may process events for the same entity in parallel.

**Solution for ordered processing in Redis Streams:**

Option A: One stream per entity type, one consumer, strong ordering within the stream.

Option B: Multiple streams, each dedicated to a consistent subset of entities (similar to Kafka partitions). Route by `hash(entityId) % num_streams`.

Option C: Accept that consumers process events in arrival order and use database-level state machines to handle out-of-order application.

---

## Retry safety — retryable vs non-retryable errors

Not all failures should be retried. Retrying a non-retryable error (e.g., business rule violation) wastes resources and can block the entire consumer.

```python
class RetryableError(Exception):
    """Downstream service unavailable, network timeout — retry is safe."""
    pass

class NonRetryableError(Exception):
    """Business rule violation, invalid data — retry will not fix this."""
    pass

def process_event(event: dict):
    try:
        result = payment_service.process(event["payment"])
    except TimeoutError:
        raise RetryableError("Payment service timeout")
    except InvalidBetStateError as e:
        raise NonRetryableError(f"Bet in wrong state: {e}")

# Consumer loop
def consume():
    for message in consumer.poll():
        try:
            process_event(message.value)
            consumer.commit()
        except RetryableError:
            # Exponential backoff, then retry
            time.sleep(backoff_seconds)
            # Do NOT commit — Kafka will redeliver
        except NonRetryableError as e:
            # Send to dead letter topic — do not retry
            producer.send("bet-events-dlq", message.value)
            consumer.commit()  # Commit to move past this message
            alert(f"Non-retryable error: {e}")
```

---

## Dead Letter Queue (DLQ) — the safety valve

A DLQ is a separate topic/stream where messages go when they cannot be processed after N retries. At Winamax, every event consumer should have a DLQ.

```
bet-events          → normal processing
bet-events-retry    → messages retried up to 3 times (with delay)
bet-events-dlq      → messages that failed all retries — requires human investigation
```

**DLQ monitoring:** A growing DLQ is a P2 alert. It means the system is dropping events rather than processing them. The SRE response is:
1. Inspect DLQ messages — what is the error pattern?
2. Is the downstream service down? Is the data malformed?
3. Fix the root cause
4. Replay DLQ messages once the fix is deployed

**DLQ replay in Kafka:**
```bash
# Move DLQ messages back to the original topic for reprocessing
kafka-consumer-groups.sh --reset-offsets --group settlement-processor --topic bet-events-dlq --to-earliest --execute

# Or use Kafka MirrorMaker to copy DLQ → main topic
```

---

## The Saga pattern — distributed transactions without 2PC

Winamax has 700+ services. A bet placement may involve: wallet service (debit funds), bet service (create bet record), odds service (lock odds), notification service (confirm to user). A distributed transaction across all four is not feasible.

**The Saga pattern:** each step is a local transaction. If a step fails, compensating transactions roll back the previous steps.

```
Step 1: Wallet debit $25.00 → wallet.debited event
Step 2: Bet created → bet.created event  
Step 3: Odds locked → odds.locked event
Step 4: Notification sent → notification.sent event

Failure at step 3 (odds not available):
  Compensate step 2: cancel the bet record
  Compensate step 1: wallet refund $25.00
```

Each service listens to the event stream and takes its action. Compensation events flow in reverse. The saga orchestrator (or choreography pattern without a central coordinator) manages the flow.

**Key property:** Compensating transactions must also be idempotent — if the refund event is retried, the wallet service must not refund twice.

---

## Interview framing

When asked "how do you handle duplicate events in your system" — the wrong answer is "we make sure to only send once." The right answer:

> "We design every consumer to be idempotent. The delivery guarantee at the infrastructure level is at-least-once, so our application layer assumes it will see duplicates. For financial events, we use database-level unique constraints on the business key — the constraint rejects the second insert, and we log and skip. For non-financial events, we use a Redis deduplication key with an appropriate TTL. The TTL is set based on our maximum expected redelivery window — if Kafka can redeliver up to 7 days of events, our deduplication TTL must be at least 7 days."
