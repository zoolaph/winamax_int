# Exercise 2 — Redis Streams Consumer Groups

## Scenario

The Casino team at Winamax processes real-time game events using Redis Streams. Each event represents something that happened in a live game: `card_dealt`, `bet_placed`, `hand_resolved`, `player_disconnected`.

The stream is `casino:game:events`. Events are produced by the game server at up to 50,000 events/second during peak poker tournament activity. Three consumer services read from this stream:

1. **game-state-updater** — updates the current hand state in DynamoDB
2. **audit-logger** — writes every event to S3 for compliance
3. **notification-dispatcher** — sends real-time WebSocket updates to connected clients

Each service has its own consumer group so they each receive all events independently.

---

## Task 1: Set up the consumer groups

Write the Redis commands to:
1. Create the stream and all three consumer groups in one pass (hint: MKSTREAM flag)
2. Create the groups starting from the current end of the stream (`$`) so they only process new events

```redis
-- Consumer group 1: game-state-updater
XGROUP CREATE ______________ ______________

-- Consumer group 2: audit-logger
XGROUP CREATE ______________

-- Consumer group 3: notification-dispatcher
XGROUP CREATE ______________
```

---

## Task 2: Consumer implementation

Write pseudocode for the `game-state-updater` consumer loop. It should:
- Read up to 50 messages per batch
- Block for up to 500ms if no new messages
- Acknowledge messages only after successful processing
- Handle the case where a message fails processing (do not acknowledge — let it go to pending)

```python
def run_game_state_consumer(redis, group="game-state-updater", consumer_name="worker-1"):
    while True:
        # Read new messages
        messages = ____________________
        
        for stream, entries in messages:
            for message_id, fields in entries:
                try:
                    ____________________  # Process
                    ____________________  # Acknowledge
                except Exception as e:
                    ____________________  # Do NOT acknowledge — what do you log?
```

---

## Task 3: Recovering stuck messages

The `game-state-updater` worker-2 crashed 10 minutes ago. It had 847 messages in its pending-entries list (PEL) — messages that were delivered but never acknowledged.

Write the Redis commands to:
1. Check how many messages are pending for this consumer group and which consumers have them
2. Claim all of worker-2's pending messages for worker-1 (messages idle for more than 5 minutes)

```redis
-- Step 1: Inspect pending messages
XPENDING ______________

-- Step 2: Claim idle messages for worker-1
-- (XCLAIM or XAUTOCLAIM)
XAUTOCLAIM ______________
```

---

## Task 4: Stream size management

The `casino:game:events` stream is growing unboundedly. During a 24-hour poker tournament, it accumulates ~4 billion events. Redis memory is under pressure.

Question A: What Redis command limits the stream to the last 1,000,000 entries at append time?

```redis
XADD casino:game:events ______________ * event_type card_dealt ...
```

Question B: The audit-logger consumer group needs to process every event, even if it is slow. If you trim the stream to 1,000,000 entries but the audit-logger falls 2,000,000 entries behind, what happens? How do you solve this?

```
Answer:
____________________
```

---

## Task 5: Monitoring consumer group health

What is the key metric to monitor for a Redis Streams consumer group health? Write the command and explain what the output means.

```redis
Command: ____________________

Output interpretation:
____________________
```

---

## Answer Key

### Task 1: Create consumer groups

```redis
-- Consumer group 1: game-state-updater (start from current end)
XGROUP CREATE casino:game:events game-state-updater $ MKSTREAM

-- Consumer group 2: audit-logger
XGROUP CREATE casino:game:events audit-logger $ MKSTREAM

-- Consumer group 3: notification-dispatcher
XGROUP CREATE casino:game:events notification-dispatcher $ MKSTREAM
```

`$` means "start from now — only process events added after this group was created."
`0` would mean "start from the beginning of the stream."
`MKSTREAM` creates the stream if it does not exist yet.

### Task 2: Consumer loop

```python
def run_game_state_consumer(redis, group="game-state-updater", consumer_name="worker-1"):
    while True:
        # Read up to 50 new messages, block 500ms if none available
        # ">" means "messages not yet delivered to any consumer in this group"
        messages = redis.xreadgroup(
            groupname=group,
            consumername=consumer_name,
            streams={"casino:game:events": ">"},
            count=50,
            block=500
        )
        
        if not messages:
            continue  # Timeout — loop and try again
        
        for stream_name, entries in messages:
            for message_id, fields in entries:
                try:
                    update_game_state(fields)  # Process
                    redis.xack("casino:game:events", group, message_id)  # Acknowledge
                except Exception as e:
                    # Do NOT acknowledge — message stays in PEL for this consumer
                    # Another worker can claim it after idle timeout
                    logger.error(
                        f"Failed to process message {message_id}: {e}. "
                        f"Message will remain in PEL for reclaim."
                    )
                    # Optional: track consecutive failures to detect poison pills
                    failure_count = redis.incr(f"failures:{message_id}")
                    if failure_count >= 3:
                        # Send to dead letter stream after 3 failures
                        redis.xadd("casino:game:events:dlq", fields)
                        redis.xack("casino:game:events", group, message_id)
```

### Task 3: Recovering stuck messages

```redis
-- Step 1: Inspect pending messages for the group
XPENDING casino:game:events game-state-updater - + 10
-- Shows: message ID, consumer name, idle time (ms), delivery count
-- Look for messages with idle time > 600000ms (10 minutes) = worker-2's messages

-- Step 2: Auto-claim messages idle > 5 minutes (300000ms) for worker-1
-- XAUTOCLAIM: faster than XCLAIM for bulk reclaim
XAUTOCLAIM casino:game:events game-state-updater worker-1 300000 0-0 COUNT 1000
-- Returns: [next-start-id, [[id, fields], ...], [deleted-ids]]
-- Call repeatedly until next-start-id is "0-0" (all claimed)
```

### Task 4: Stream size management

**Question A:**
```redis
XADD casino:game:events MAXLEN ~ 1000000 * event_type card_dealt hand_id 12345 player_id 456
```
`~` means approximate trimming (faster — Redis trims when convenient, not on every append). Without `~`, every `XADD` trims exactly to 1,000,000 which is slower.

**Question B:**
If you trim the stream to 1,000,000 entries but audit-logger is 2,000,000 behind, the entries it needs to process have been deleted. It will try to read message IDs that no longer exist — Redis will return an error or skip to the oldest available entry.

**Solutions:**
1. **Separate stream for audit:** Give the audit-logger its own stream with a longer retention (or no MAXLEN). The game server writes to both. Audit is the only consumer that needs full history.
2. **S3 archival before trim:** A background job archives old stream entries to S3 before they are trimmed. Audit-logger reads from Redis when possible, falls back to S3 for old entries.
3. **Size the stream to the audit-logger's worst-case lag:** If audit-logger can fall 2M messages behind, set MAXLEN to 3,000,000 with a memory budget to match.

The most operationally correct solution is option 1 — separate the high-retention use case (compliance audit) from the low-retention use case (real-time game state).

### Task 5: Monitoring consumer group health

```redis
XINFO GROUPS casino:game:events
```

Key fields in output:
- `name`: consumer group name
- `consumers`: number of consumers in the group
- `pending`: **number of messages delivered but not yet acknowledged** — the critical metric
  - A growing `pending` count means consumers are not keeping up or are crashing
  - A `pending` that reaches your stream MAXLEN means you are losing messages
- `last-delivered-id`: the ID of the last message delivered to this group
- `lag`: (Redis 7.0+) estimated number of messages between last-delivered-id and the stream end

**Alert on:** `pending > 10,000` or `lag growing over time without decreasing`.
A large lag that keeps growing means the consumer group is falling behind faster than it is processing — add consumers or investigate processing latency.
