# Privacy in Observability — Why You Cannot Log Raw Bet or Player Data

This is not a compliance checkbox. It is a fundamental design constraint that changes how you instrument 700+ microservices. Understanding this clearly is a strong signal to Winamax that you have thought seriously about their context.

---

## Why Winamax built their own stack

The Winamax observability stack is 100% self-hosted. The reason is stated directly: **player data confidentiality**. This means:

1. No telemetry data (traces, logs, metrics with player identifiers) leaves Winamax's infrastructure
2. No SaaS tools (Datadog, New Relic, Honeycomb, Splunk Cloud) are acceptable — they would receive player data
3. Even within self-hosted tools, what data goes in must be designed carefully

This is driven by two overlapping frameworks:

**GDPR (EU):**
- Personal data includes: name, email, IP address, payment data, betting history linked to a person
- Must have a legal basis for processing
- Data minimization principle: collect only what you need
- Right to erasure: if a player requests deletion, their data must be removable from your systems — including potentially your observability data

**French Gambling Regulations (ANJ — Autorité Nationale des Jeux):**
- Strict rules on what player and betting data can be shared with third parties
- Audit trail requirements — you need logs, but they must be controlled

---

## The principle: IDs, not values

The core rule is simple:

```
In observability data:
  ✓ Use: bet.id, player.id, session.id     (opaque identifiers)
  ✗ Never: bet.amount, player.name, player.email, player.phone
  ✗ Never: card.number, card.cvv, payment.method details
  ✗ Never: IP addresses linked to a player
  ✗ Never: bet selections with player context (e.g., "PLY-123 bet on Real Madrid")
```

Why is `player.id` OK? An internal ID is only PII when combined with other data that identifies the person. Alone, `PLY-44123` is meaningless to anyone outside Winamax. The concern is data that identifies the person directly or can be combined with external data to do so.

**Note:** Even `player.id` should be reviewed. If GDPR right-to-erasure applies, having `player.id` in 90 days of traces means you'd need to scrub traces on deletion requests. Some teams hash or pseudonymize IDs in traces for this reason.

---

## Where privacy violations happen in observability

### 1. SQL queries in trace attributes

The most common mistake: the OTel pg/mysql instrumentation captures `db.statement` by default.

```
❌ db.statement: "SELECT * FROM players WHERE email = 'alice@example.com'"
❌ db.statement: "INSERT INTO bets (player_id, amount, selection) VALUES (44123, 50.00, 'Real Madrid')"
```

**Fix:** Disable or sanitize `db.statement` in the OTel SDK config:

```javascript
// In instrumentation.js
'@opentelemetry/instrumentation-pg': {
  // Only capture the operation type, not the full statement
  dbStatementSerializer: (operation, queryConfig) => {
    // Return just the SQL keyword, not the full query
    return queryConfig.text?.split(' ')[0] || operation;
    // e.g., "SELECT", "INSERT", "UPDATE"
  },
},
```

Or use the `attributes` processor in the Collector to delete it entirely:
```yaml
processors:
  attributes/scrub-sql:
    actions:
      - key: db.statement
        action: delete
```

### 2. HTTP request/response body logging

```
❌ Log: POST /api/bet/place body: {"player_id": 44123, "amount": 50, "card": "4111..."}
❌ Span attribute: http.request_body: "{...with PII...}"
```

Never capture request or response bodies in spans or logs unless you explicitly know they contain no PII and you have a specific reason. For the betting API, request bodies contain bet amounts and potentially player session data.

**Fix:** Auto-instrumentation does NOT capture request bodies by default. This is intentional. Do not add body capture.

### 3. Error messages leaking data

```
❌ Error: "Bet validation failed: player Alice (alice@example.com) has insufficient funds: €42.50 balance"
✓ Error: "Bet validation failed: reason=insufficient_funds, player_id=PLY-44123"
```

Application error messages often include helpful debugging context that includes PII. Review all `throw new Error()` and `logger.error()` calls for data values.

### 4. Kafka message headers or body in traces

```
❌ Span attribute: kafka.message.value: "{\"player_id\": 44123, \"bet_amount\": 50, ...}"
✓ Span attribute: kafka.message.key: "bet-98234" (if the key is a bet ID, not player data)
```

The kafkajs OTel instrumentation does not capture message bodies by default, but verify this.

### 5. User-Agent and IP in HTTP spans

```
❌ http.user_agent: "Mozilla/5.0... (identifies client, combined with IP = PII)
❌ http.client_ip: "82.x.x.x" (IP address = personal data under GDPR)
```

**Fix:**
```javascript
'@opentelemetry/instrumentation-http': {
  requestHook: (span, request) => {
    // Remove IP and user-agent from spans
    span.setAttribute('http.client_ip', undefined);
    span.setAttribute('http.user_agent', undefined);
  },
},
```

Or in the Collector attributes processor:
```yaml
attributes/scrub-http-pii:
  actions:
    - key: http.client_ip
      action: delete
    - key: http.user_agent
      action: delete
```

---

## The OTel Collector as the privacy enforcement layer

The Collector is the right place for final privacy enforcement because:
1. It is the last point before data reaches the backend
2. You can enforce it once for all 700 services
3. Application teams cannot accidentally bypass it
4. You can audit what comes out of the Collector

```yaml
# Privacy enforcement pipeline in the Collector
processors:
  attributes/privacy:
    actions:
      # Hard delete — never allowed
      - key: player.name
        action: delete
      - key: player.email
        action: delete
      - key: player.phone
        action: delete
      - key: bet.amount
        action: delete
      - key: payment.card_number
        action: delete
      - key: http.client_ip
        action: delete
      - key: db.statement
        action: delete

      # Hash — preserves cardinality for debugging, removes raw value
      # Use only if the ID alone is not considered PII at your compliance level
      - key: player.id
        action: hash   # SHA256 hash
```

Defense in depth: even if an application accidentally includes a PII field in a span attribute, the Collector processor removes it before it reaches Jaeger or Quickwit.

---

## Designing instrumentation with privacy by default

The right mental model is: treat all user-provided data as PII until proven otherwise.

```
Safe to include in spans:
  - Internal IDs (bet_id, session_id, event_id)
  - Enum values (bet_type: "single", payment_status: "pending")
  - Non-identifying counts and durations (bet.selection_count: 3, duration_ms: 142)
  - Operation outcomes (validation.result: "failed", reason: "odds_changed")
  - Error types (error.type: "DatabaseConnectionError")

Not safe:
  - Any user-provided string (names, emails, messages)
  - Financial amounts
  - Location data
  - Device identifiers
  - IP addresses
  - Query parameters that may contain search terms or player info
```

---

## The GDPR right-to-erasure problem with traces

If a player requests GDPR erasure, you must delete their personal data. If traces contain `player.id`, you theoretically need to scrub traces containing that player's activity.

This is operationally complex for distributed traces stored as immutable objects on S3.

**Solutions:**
1. **Don't put player.id in traces** (cleanest — then traces are not personal data)
2. **Pseudonymize at ingestion** — hash the player_id with a key; on erasure request, delete the key (crypto-erasure)
3. **Accept short retention** — if traces only live for 30 days, the problem is smaller
4. **Separate tier for traces touching player data** — flag traces with player context, subject to stricter lifecycle

Winamax's chosen solution is likely option 1 + option 3 based on their self-hosted + confidentiality stance.

---

## The interview answer

**Q: "How do you prevent player data from ending up in your traces and logs?"**

A: "It is a layered approach. First, we define what can and cannot go into telemetry — use IDs, not values. We document this as a team standard. Second, we configure the OTel SDK auto-instrumentation to suppress fields that commonly leak data — db.statement is the big one, SQL queries with player data. Third, and most importantly, we enforce privacy at the OTel Collector level: every pipeline runs an attributes processor that deletes or hashes any field that should never reach the backends. This means even if an application accidentally includes a sensitive field, it never makes it to Jaeger or Quickwit. The Collector is our privacy enforcement point. Fourth, the backends are self-hosted — no data leaves our infrastructure. That is the reason we built this stack ourselves rather than using a SaaS tool."
