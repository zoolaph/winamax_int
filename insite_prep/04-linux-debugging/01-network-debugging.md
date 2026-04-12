# Linux Debugging 01 — Network

## How to use this file

Each scenario gives you terminal output. Before reading the next step, write down:
1. What command you would run next
2. What you are looking for in its output

Treat it as a real terminal session. The answer follows each scenario.

---

## Scenario 1: Service cannot reach its database

**Context:** A new ECS task started. The application logs show:

```
Error: connect ETIMEDOUT 10.0.3.45:5432
    at TCPConnectWrap.afterConnect
```

You have exec'd into the container. You are at a bash prompt inside the task.

**What do you run first?**

---

**Step 1 — Test TCP connectivity directly:**

```bash
# Can we reach the DB host at all?
curl -v telnet://10.0.3.45:5432 --connect-timeout 5
# Or:
timeout 5 bash -c "echo > /dev/tcp/10.0.3.45/5432" && echo "TCP open" || echo "TCP refused/timed out"
```

**Output:**
```
bash: connect: Connection timed out
bash: /dev/tcp/10.0.3.45/5432: Connection timed out
TCP refused/timed out
```

`Connection timed out` (not `Connection refused`). Timed out = no response at all = packets are being dropped. Refused = the host received the packet but nothing is listening on that port.

**What does this tell you?**

Timeout = the problem is in the network path (security group, NACL, routing) before the packet even reaches the database server. Refused = the database is reachable but nothing is listening on 5432 (wrong port, DB not running).

**Step 2 — Check if we can reach anything:**

```bash
# Can we reach the internet?
curl -s --connect-timeout 3 https://8.8.8.8 && echo "internet OK" || echo "internet unreachable"

# Can we reach other internal services?
curl -s --connect-timeout 3 http://10.0.1.10:8080/health && echo "OK" || echo "unreachable"
```

If internet unreachable AND internal unreachable: the task's security group has no outbound rule, or there is no route to a NAT Gateway.

If internal reachable but DB not: the DB security group is blocking inbound from this task's SG.

**Step 3 — Check the routing table inside the container:**

```bash
ip route show
# or
route -n
```

**Output:**
```
default via 10.0.2.1 dev eth0 proto dhcp src 10.0.2.45 metric 100
10.0.2.0/24 dev eth0 proto kernel scope link src 10.0.2.45
```

The task's IP is `10.0.2.45`. The database is at `10.0.3.45` (different subnet). The route goes via the gateway `10.0.2.1` — which should route to the DB subnet through the VPC routing table.

**Root cause in this scenario:** The database security group `sg-rds` is missing an inbound rule allowing TCP 5432 from the ECS task's security group. The packet leaves the task, travels to the DB subnet, and is dropped by the security group before reaching the DB.

**Fix:** Add to the RDS security group:
```
Inbound: TCP 5432 from sg-ecs-tasks
```

---

## Scenario 2: Intermittent DNS failures

**Context:** An ECS service reports intermittent `getaddrinfo ENOTFOUND` errors when calling another internal service. It fails on ~2% of requests, then recovers.

**What do you run?**

---

**Step 1 — Test DNS resolution manually:**

```bash
# Resolve the service name
nslookup payment-api.winamax.internal
# or
dig payment-api.winamax.internal

# Resolve multiple times quickly to see intermittent failures
for i in $(seq 1 20); do
  dig +short payment-api.winamax.internal || echo "FAILED"
done
```

**Output (intermittent):**
```
10.0.1.45
10.0.1.45
FAILED
10.0.1.45
FAILED
10.0.1.45
```

DNS is intermittently failing. This is not "never resolves" — it is sometimes fails.

**Step 2 — Check which DNS server the container is using:**

```bash
cat /etc/resolv.conf
```

**Output:**
```
nameserver 169.254.169.253
search eu-west-3.compute.internal
options ndots:5
```

`169.254.169.253` is the AWS VPC DNS resolver. All DNS in AWS VPC goes through this address.

**Step 3 — Check if the DNS server is reachable:**

```bash
dig @169.254.169.253 payment-api.winamax.internal
```

If this succeeds consistently: the DNS server is fine. The intermittent failure is in the application's DNS client implementation (timeout, retry policy).

**Step 4 — Check the application's DNS resolver settings:**

In Node.js, DNS TTL is 0 by default — every lookup hits the DNS server. Some languages/runtimes cache DNS aggressively. If the ECS task is making thousands of DNS lookups per second (not caching), it can hit the rate limit on the VPC DNS resolver (1,024 packets/second per ENI).

**Root cause in this scenario:** The service makes a DNS lookup for every outbound HTTP request (no connection reuse, no DNS caching). At high throughput, it hits the VPC DNS rate limit of 1,024 lookups/second.

**Fix:**
1. Enable connection keep-alive in the HTTP client (reuse TCP connections, avoid repeat DNS)
2. Add DNS caching at the application level with a 30-second TTL
3. Alternatively: use IP addresses directly for stable internal services (Service Connect in ECS provides stable IP routing)

---

## Scenario 3: TLS handshake failing

**Context:** Service logs show:

```
Error: unable to verify the first certificate
    at TLSSocket.<anonymous>
```

**Diagnose with `openssl`:**

```bash
# Test the TLS handshake manually
openssl s_client -connect api.partner.com:443 -brief

# Show the full certificate chain
openssl s_client -connect api.partner.com:443 -showcerts 2>/dev/null \
  | openssl x509 -text -noout | grep -A 2 "Subject:\|Issuer:\|Not After"
```

**What to look for:**
- `Verify return code: 0 (ok)` — TLS is valid
- `Verify return code: 21 (unable to verify the first certificate)` — chain is incomplete
- `Not After` date — is the certificate expired?
- `Subject` vs `Issuer` — is this a self-signed certificate (Subject == Issuer)?

**Common causes of TLS failure in containers:**
1. The container's CA bundle is outdated — the certificate authority is not in the bundle
2. The certificate is expired
3. The certificate is for a different hostname (SNI mismatch)
4. Corporate proxy is doing TLS inspection and injecting its own certificate

**Check the hostname:**
```bash
# Does the certificate match the hostname we're connecting to?
openssl s_client -connect api.partner.com:443 -servername api.partner.com 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName
```

---

## Scenario 4: `ss` — reading connection states

**Context:** You are debugging why a service has 1,200 open connections to the database but the pool is configured for 50.

```bash
# Show all TCP connections for the process
ss -tnp | grep <port>

# Count connections by state
ss -tn | grep :5432 | awk '{print $1}' | sort | uniq -c | sort -rn
```

**Output:**
```
847 ESTABLISHED
350 TIME_WAIT
  3 CLOSE_WAIT
```

**Reading this:**
- `ESTABLISHED` — active connection
- `TIME_WAIT` — connection was closed, waiting for delayed packets (normal, ephemeral, last ~60 seconds)
- `CLOSE_WAIT` — the remote end closed the connection but the local application has not called `close()` — this is a **connection leak** if the count is high and growing

847 ESTABLISHED connections when the pool is configured for 50: something is creating connections outside the pool. Or the pool size configuration is not taking effect.

**Check what process owns the connections:**
```bash
ss -tnp | grep :5432 | head -5
# Shows: pid=<pid>,fd=<fd> for each connection
```

---

## Scenario 5: `tcpdump` — confirm a connection is being attempted

**Context:** You suspect the application is not actually connecting to the Kafka broker at `10.0.4.20:9092`. The app logs show no errors, but also no messages. You want to confirm whether TCP packets are leaving the container.

```bash
# Capture TCP traffic on port 9092 (requires root/NET_CAP_RAW)
tcpdump -i eth0 -n port 9092 -c 20

# Or filter by destination IP
tcpdump -i eth0 -n host 10.0.4.20 -c 20
```

**Output (connection is happening):**
```
21:03:41.123 IP 10.0.2.45.52341 > 10.0.4.20.9092: Flags [S], seq 0
21:03:41.124 IP 10.0.4.20.9092 > 10.0.2.45.52341: Flags [S.], seq 0, ack 1
21:03:41.124 IP 10.0.2.45.52341 > 10.0.4.20.9092: Flags [.], ack 1
```

SYN → SYN-ACK → ACK = three-way handshake completed. TCP connection is established. If the application is not sending messages, the problem is at the application layer, not the network.

**Output (connection is not happening):**
```
# (no output after 10 seconds)
```

No packets leaving the container = the application is not attempting the connection. Check the Kafka client configuration — wrong broker address, client not initialized, wrong topic name causing silent failure.

**Output (SYN with no response):**
```
21:03:41.123 IP 10.0.2.45.52341 > 10.0.4.20.9092: Flags [S], seq 0
21:03:44.123 IP 10.0.2.45.52341 > 10.0.4.20.9092: Flags [S], seq 0 (retransmit)
```

SYN sent, no SYN-ACK = broker not responding. Security group or broker is down.
