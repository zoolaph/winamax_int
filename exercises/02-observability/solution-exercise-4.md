# Solution: Exercise 4 — Sampling Strategy Design

---

## 1. Head-based or tail-based? Why?

**Answer: Tail-based sampling.**

Reasoning:
- The core requirement is to not miss error traces on the betting path (99.9% SLO)
- With head-based sampling, the decision is made at the start of the trace — before you know if it will error or be slow
- If you sample at 5% head-based, you will drop ~95% of error traces — unacceptable for production debugging
- Tail-based sampling buffers all spans until the trace completes, then decides: if any span errored or the total duration exceeded 300ms → keep unconditionally

The cost is Collector complexity and memory (buffering in-progress traces), but it is the right trade-off for a production platform.

---

## 2. Sampling policy

```yaml
tail_sampling:
  decision_wait: 10s
  policies:

    # 100%: all error traces — never miss a failure
    - name: keep-errors
      type: status_code
      status_code:
        status_codes: [ERROR]

    # 100%: all slow traces > 300ms — catch latency regressions
    - name: keep-slow-traces
      type: latency
      latency:
        threshold_ms: 300

    # 100%: traces on the critical money path — bet placement, payment, auth
    - name: keep-critical-paths
      type: string_attribute
      string_attribute:
        key: service.name
        values:
          - "betting-api"
          - "payment-service"
          - "auth-service"
          - "wallet-service"

    # 5%: everything else (healthy, fast, non-critical)
    - name: probabilistic-catchall
      type: probabilistic
      probabilistic:
        sampling_percentage: 5
```

---

## 3. Approximate retained trace volume per day

Assumptions:
- 10,000 HTTP requests/second across all services
- Error rate: ~0.1% (at SLO) → 10 errors/second
- Slow traces (>300ms): ~2% of traffic → 200/second
- Critical path services: ~30% of all requests → 3,000/second (kept at 100%)
- Non-critical normal traffic: 70% × ~97.9% = ~6,790/second × 5% = ~340/second

Rough total traces retained per second:
```
errors:         10/sec   (all kept)
slow:          200/sec   (all kept, some overlap with errors)
critical path: 3,000/sec (all kept, some overlap with above)
normal 5%:       340/sec

Total retained: ~3,550/sec (significant overlap — real number is closer to 3,000-3,500/sec)
```

Per day:
```
3,500 traces/sec × 86,400 sec/day = ~302 million traces/day

At 20 spans/trace × 2KB/span = 40KB/trace:
302 million × 40KB = ~12 TB/day
```

That is still very large. At Winamax you would adjust:
- Keep critical path at 100% only for services you are actively debugging
- Drop to 1% for truly healthy non-critical services
- Use Quickwit S3 storage for affordable retention at this volume

**Real-world note:** Winamax with tail sampling in production would tune these numbers empirically. Start conservative (keep more), then dial down sampling rate as storage costs become visible.

---

## 4. Memory estimate for tail sampling buffer

Calculation:
- `decision_wait`: 10s (Collector holds all spans of a trace for up to 10s)
- New traces/sec: 10,000 (before sampling)
- Traces in-flight at any time: 10,000 × 10s = 100,000 traces in buffer
- Average spans per trace: 20
- Average span size in memory: ~5KB (larger than serialized size due to object overhead)

```
100,000 traces × 20 spans × 5KB = 10 GB
```

This is the upper bound. In practice, most traces complete in < 1s, so the average in-flight buffer is much smaller. With `num_traces: 100000` and 1-second average trace duration, the buffer holds ~10,000 active traces at a time.

**Recommended Collector gateway memory:** 4-8 GB with `memory_limiter` set to 6GB limit.

---

## 5. What happens when a Collector gateway crashes?

**Problem:** Tail sampling requires all spans of a trace to arrive at the same Collector instance. If a gateway crashes:
- In-flight trace decisions are lost
- Spans being held in the buffer are lost
- New spans arrive at other gateways with no context

**Mitigations:**

1. **Run 2+ gateway instances** — crash of one does not affect traces routed to others. At 50% loss of capacity, the surviving instance is overloaded but available. The lost traces are traces that were mid-flight on the crashed instance only.

2. **Short `decision_wait`** — 10s of buffered traces is far less loss than 60s.

3. **Head-based sampling as fallback** — configure SDK with a small head-based sampler (1%) as a safety net. If tail sampling loses traces, at least 1% are always kept regardless of the Collector state.

4. **ECS service with multiple tasks** — let ECS restart the Collector task automatically. With `minimumHealthyPercent=50` and 2 tasks, one crash is self-healing with no manual intervention.

5. **Accept the loss** — tail sampling crashes lose some in-flight traces. If the window is small (10s) and the crash is rare, this is acceptable. The alternative — persisting all spans to disk before sampling — adds significant latency to the write path.

**The honest answer:** there is no zero-loss solution for stateful tail sampling without a distributed coordination layer (like Kafka). The trade-off is simplicity + occasional trace loss vs complexity + no loss. For Winamax, simplicity + short `decision_wait` + HA deployment is the right call.
