# Module 6 Interview Questions — Database Operations & Access Governance

These are the questions Winamax will actually ask. The DB access governance topic is a named project in their JD — expect detailed probing here.

---

## Q1: Walk me through how you would design a system to automate database access management across 700+ services.

**Answer:**

The problem is scale and accountability. At 700 services, you cannot have a DBA manually granting and revoking access. And you cannot have shared credentials — if one service's credentials are compromised, you have no way to scope the blast radius.

The design I would build has three components.

First, a self-service request portal — a Slack command, a web UI, or a CLI tool. The engineer specifies: which database, which tables, what privilege level (SELECT vs SELECT+INSERT), and for how long. They also provide a reason, ideally linking an incident ticket. The system validates the request against policy — a developer on the payments team cannot request access to the user authentication database without escalated approval.

Second, automated provisioning. For approved requests — auto-approved for read-only under 4 hours, manager-approved for write or extended access — a Lambda creates an ephemeral DB user. The username encodes who it is and when it expires: `farouq_temp_20240115_1430`. The credentials go directly into Secrets Manager with a TTL. The developer retrieves them via their own IAM identity — that retrieval is logged in CloudTrail.

Third, automatic cleanup. Every 5 minutes, a scheduled Lambda checks DynamoDB for expired access records and drops the DB user. No manual revocation. No forgotten credentials.

The key architectural decision is doing the DB user management as code — the provisioning Lambda connects as a privileged `db_provisioner` user (via IAM auth itself, no stored password) and executes `CREATE USER`, `GRANT`, and `DROP USER`. The provisioner user has only `GRANT OPTION` on the tables it manages, not superuser privileges.

Every grant, every retrieval, every expiry is written to S3 with Object Lock. That is your audit trail for the CNIL.

---

## Q2: How does Aurora MySQL differ from standard RDS MySQL? When does the difference matter operationally?

**Answer:**

The architectural difference is in the storage layer. Standard RDS MySQL replicates by streaming the binlog to replicas — the primary writes to its local disk, then replicas re-apply the log. Aurora uses a shared distributed storage volume across 6 nodes in 3 AZs. The writer and all readers read from and write to the same storage.

This makes three things different operationally.

Failover speed. In standard RDS, a failover requires the replica to catch up with binlog it has not yet applied. During a peak period with heavy write traffic, that lag can be 60–120 seconds. In Aurora, the replica already has the data in shared storage — promotion is just handing over the write lock. Failover takes 30 seconds instead of 90.

Replication lag. In standard RDS replication, lag under heavy load is normal and can reach seconds. Aurora replica lag is typically under 10ms because there is no log shipping — replicas read directly from storage. For read replicas serving real-time odds data, that 10ms vs 5-second difference is the difference between correct and stale data being shown to users.

Scale. Aurora storage auto-scales in 10GB increments up to 128TB without any maintenance window. Standard RDS requires provisioning storage upfront and a brief downtime to modify.

The one difference that burns people: Aurora does not have binlog replication to external systems by default. If you need to replicate to an on-premise system or run Debezium for CDC, you must explicitly enable `binlog_format=ROW` in the parameter group. It is not on by default in Aurora.

---

## Q3: A developer reports they are getting "Too many connections" errors from the payment service. Walk me through your investigation.

**Answer:**

Too many connections means one of two things: the client is opening more connections than Aurora can accept, or there is a connection leak — connections that are being opened but not properly closed.

First, I check the current state. On Aurora, `SHOW STATUS LIKE 'Threads_connected'` tells me how many connections are currently open. The `max_connections` parameter tells me the ceiling. If `Threads_connected` is near `max_connections`, the limit is being hit. If `Threads_connected` is low, the error is intermittent and might be a burst.

Second, I check where the connections are coming from. `SELECT user, host, COUNT(*) FROM information_schema.PROCESSLIST GROUP BY user, host ORDER BY count DESC`. This tells me which service is consuming the most connections. If the payment service has 800 connections and the ceiling is 1,000, the other 200 services are competing for what is left.

If it is a leak, I look for idle connections that are piling up. `SELECT * FROM information_schema.PROCESSLIST WHERE COMMAND = 'Sleep' AND TIME > 600`. Connections sleeping for over 10 minutes are likely leaked — the application opened them and never returned them to the pool.

The fix depends on the root cause. If it is a connection pool misconfiguration — pool size set too high, no idle timeout — I fix the application configuration. If it is a genuine scale problem with 700 services all needing connections, the structural fix is RDS Proxy.

RDS Proxy sits between the application and Aurora and multiplexes thousands of application connections onto a small pool of backend connections. The application sees what appears to be a normal MySQL endpoint, but Aurora sees 200 connections instead of 17,500. The payment service can request 100 connections from the proxy; the proxy handles the multiplexing transparently.

---

## Q4: Explain DynamoDB's partition key design constraints. How would you handle a hot partition for Winamax's live odds data?

**Answer:**

DynamoDB distributes data across partitions by hashing the partition key. Each partition has throughput limits — up to 3,000 RCUs and 1,000 WCUs per second. If all traffic targets the same partition key value, that one partition becomes a bottleneck regardless of how much capacity you provisioned for the table overall.

For live odds data, the natural key would be `eventId`. During a Champions League final, every service wants `eventId = MATCH-CL-FINAL-001`. Thousands of reads per second, all to one partition key. That is a hot partition.

There are two strategies.

The first is write sharding. Append a random suffix: `MATCH-CL-FINAL-001#0`, `MATCH-CL-FINAL-001#1`, through `MATCH-CL-FINAL-001#9`. Distribute writes across 10 virtual partitions. When reading, the application queries all 10 shards and merges. This is more complex in the application layer but scales linearly with the shard count.

The second — and better for read-heavy scenarios — is caching. The odds for a single event are read far more than they are written. The odds change every few seconds; they are read thousands of times between updates. DAX (DynamoDB Accelerator) sits in front of DynamoDB, API-compatible, and caches hot items in microseconds. The `MATCH-CL-FINAL-001` odds are read from DAX memory — DynamoDB sees only the cache misses and updates, not the full read volume.

At Winamax's scale, I would use both: DAX for the read amplification, and write sharding if the odds update rate itself becomes a bottleneck.

---

## Q5: How would you design the staging data refresh pipeline for Winamax? What PII considerations apply?

**Answer:**

The goal is a staging environment that is statistically representative of production but contains no real user data. The failure mode in both directions is expensive — a staging environment that is too fake misses real bugs; a staging environment with real data is a GDPR liability.

The pipeline has four steps.

First, snapshot. I take an Aurora snapshot of production — this has no impact on the live writer. I restore the snapshot to a temporary export instance rather than running heavy export queries against production.

Second, anonymize. I run an AWS Glue PySpark job against the exported data in S3. The job applies anonymization functions: emails become deterministic hashes (`sha256(email + salt)[:16]@anon.winamax.fr`), names become random French names via Faker, national IDs are dropped entirely, IBANs get their account number replaced with a hash while preserving the country code, IP addresses are truncated to the first two octets.

The critical property is determinism. The same email always produces the same anonymized email — using a fixed salt. This preserves relational integrity. If the same user is referenced in the `users` table, the `bets` table, and the `payments` table, they all map to the same anonymized identifier. Joins work. Without determinism, you cannot do any cross-table analysis in staging.

Third, subset. 50 TB is too large for staging. I sample 10% of users consistently: `WHERE ABS(HASH(user_id)) % 10 = 0`. Then I inner-join all other tables to this sampled user set. The same 10% of users are selected every week — engineers can bookmark a specific user ID knowing it will always exist in staging.

Fourth, cross-account copy. The anonymized data lives in the prod S3 bucket. I never move raw data to staging. An IAM role in the staging account has read access to specifically the anonymized output prefix — not the raw export. The staging import role pulls it and loads it to the staging Aurora.

On the GDPR side: the anonymization happens before the data ever crosses the account boundary. The prod account only holds anonymized data after the Glue job runs. The salt used for hashing is stored in Secrets Manager in the prod account and is never replicated to staging — so even if someone compromised staging, they could not reverse the anonymization.

---

## Q6: What is the difference between RDS Proxy and application-level connection pooling? When do you need each?

**Answer:**

Application-level pooling (HikariCP, PgBouncer, SQLAlchemy pool) keeps a pool of open connections within a single process. Instead of opening a new TCP connection to Aurora for every database operation, the application reuses connections from its pool. This reduces connection setup overhead and prevents a single application instance from opening too many connections.

The problem: with 700 ECS services and 5 tasks each, you have 3,500 processes all maintaining their own pools. If each pool has a minimum of 5 connections, Aurora sees 17,500 connections — well over the instance limit. Application-level pooling solves the problem within a single process; it does not solve the problem at the fleet level.

RDS Proxy solves the fleet-level problem. It sits between the entire ECS fleet and Aurora, acting as a shared pool. All 3,500 processes connect to the Proxy, which multiplexes them onto 200 backend connections to Aurora. The database sees 200 connections regardless of how many ECS tasks are running.

You need both in practice. Application-level pooling reduces the number of simultaneous requests each process makes to the Proxy. RDS Proxy handles the multiplexing across the fleet.

The one situation where RDS Proxy hurts rather than helps: long-running queries inside explicit transactions cause the Proxy to "pin" that application connection to a specific backend connection. A pinned connection cannot be shared — it holds a backend connection for its entire duration. If your application wraps every operation in a transaction or uses SET statements heavily, pinning reduces the multiplexing benefit. The solution is to keep transactions short and avoid unnecessary session state.

---

## Q7: How would you implement an audit trail that satisfies French CNIL requirements for database access?

**Answer:**

The CNIL requirement is essentially: you must be able to demonstrate, for any given time period, who accessed what personal data, from where, and why. The audit trail must be tamper-evident — you cannot delete it after the fact.

I implement three layers.

First, IAM and CloudTrail. Every developer retrieves DB credentials via `secretsmanager:GetSecretValue`. CloudTrail logs this call with the IAM principal, the timestamp, and the secret ARN. Even if someone tries to erase the evidence, CloudTrail logs are immutable by default — you can enable CloudTrail log integrity validation with a cryptographic digest chain.

Second, Aurora Advanced Auditing. I enable `server_audit_logging` in the Aurora parameter group, capturing CONNECT and QUERY_DML events. This logs every SQL statement: who, what, when. These logs go to CloudWatch Logs via the Aurora audit log export, then flow to S3 via Kinesis Firehose. The S3 bucket has Object Lock configured in compliance mode — once a log object is written, it cannot be deleted or overwritten for 7 years (the French gambling regulation retention requirement).

Third, application-level audit events. For structured audit trails — "user U-12345's bet history was accessed by service payment-api during request ID req-abc" — the application emits structured events to Kinesis, which delivers them to S3 and Quickwit for querying.

To answer the CNIL audit question "who accessed what personal data in the last 90 days," I query Athena against the S3 audit logs. The query joins the IAM retrieval event (who got the credentials) with the Aurora query log (what SQL was run) using a time window and session correlation.

The tamper-evidence comes from S3 Object Lock. An auditor can request the log files, and I can prove they have not been modified since creation via the Object Lock status and the CloudTrail digest chain.
