# RDS Proxy — Deep Dive

## The problem RDS Proxy solves

Aurora has a connection limit that depends on instance class. A `db.r6g.large` instance supports approximately 1,000 connections. At Winamax:

```
700 services
× 5 ECS tasks per service (on average)
× 5 connections per task (minimum connection pool)
= 17,500 connections required
```

17,500 > 1,000. Without pooling, Aurora rejects connections before load becomes a problem. The application sees `Too many connections` errors.

**Traditional solutions:**
- Scale up the instance class (expensive, finite ceiling).
- Application-level pooling (works, but each ECS task still opens its own pool to Aurora directly).

**RDS Proxy solution:**
```
17,500 application connections → RDS Proxy → 200 backend connections → Aurora
```

The Proxy maintains a small number of persistent, long-lived connections to Aurora. Application connections are multiplexed onto them. Aurora sees only 200 connections; the applications see 17,500 available connection slots.

---

## How connection multiplexing works

RDS Proxy operates in two modes per connection:

**Multiplexed (default):**
- Application connection is mapped to a backend connection only during the execution of a query.
- Between queries, the backend connection is returned to the pool.
- One backend connection can serve many application connections — as long as they don't all query simultaneously.

**Pinned:**
- The application connection is pinned to a specific backend connection for its entire lifetime.
- Pinning happens when the Proxy detects session state that cannot be safely shared: `SET` statements, temporary tables, explicit transactions, stored procedures, `LOCK TABLES`.
- Pinned connections do not participate in multiplexing — they hold a backend connection even when idle.

**Implication:** Write-heavy paths that wrap every operation in an explicit transaction (`BEGIN ... COMMIT`) create many pinned connections and reduce the pooling benefit. Keep transactions short and avoid unnecessary `SET` statements in application code.

---

## Architecture

```
                        ┌─────────────────────────────────┐
                        │         RDS Proxy                │
ECS tasks               │                                  │
┌──────────┐            │  Proxy endpoint:                 │
│ task-001 │──────┐     │  winamax.proxy-xyz.rds.amazonaws.com │
│ task-002 │──────┤     │                                  │
│ task-003 │──────┤────►│  Connection pool                 │────► Aurora Writer
│ task-004 │──────┤     │  (persistent backend connections)│────► Aurora Reader
│ task-005 │──────┘     │                                  │
└──────────┘            │  IAM authentication              │
(+ 695 more services)   │  TLS termination                 │
                        └─────────────────────────────────┘
```

RDS Proxy runs in your VPC, in your subnets. It has an endpoint that looks like a normal Aurora endpoint. Applications connect to the Proxy endpoint — no code change required beyond updating the host string.

---

## IAM authentication integration

RDS Proxy enforces IAM authentication when configured. This combines the multiplexing benefit with the security benefit of no stored passwords:

1. Application generates an IAM auth token (via `boto3.client('rds').generate_db_auth_token`).
2. Application connects to the Proxy with the token.
3. Proxy validates the token against IAM.
4. Proxy connects to Aurora using its own stored credentials (from Secrets Manager) — the application never handles the actual Aurora password.

```python
import boto3
import mysql.connector

def get_db_connection():
    client = boto3.client('rds', region_name='eu-west-3')
    
    token = client.generate_db_auth_token(
        DBHostname='winamax.proxy-xyz.eu-west-3.rds.amazonaws.com',  # Proxy endpoint
        Port=3306,
        DBUsername='app_user'
    )
    
    return mysql.connector.connect(
        host='winamax.proxy-xyz.eu-west-3.rds.amazonaws.com',
        user='app_user',
        password=token,
        database='bets_db',
        ssl_ca='/path/to/rds-ca.pem'  # SSL required for IAM auth
    )
```

---

## Failover behavior

**Without RDS Proxy:**
1. Aurora writer fails.
2. Aurora promotes a replica (~30 seconds).
3. Cluster endpoint DNS updates.
4. All application connections are broken.
5. Applications must reconnect — a burst of reconnection attempts hits the new writer simultaneously.
6. Total disruption: 30–60 seconds depending on DNS TTL and app reconnect logic.

**With RDS Proxy:**
1. Aurora writer fails.
2. RDS Proxy detects the failure (within ~5 seconds).
3. RDS Proxy reconnects to the new Aurora writer from its backend connection pool.
4. Application connections to the Proxy experience a brief stall (5–10 seconds) but are not dropped.
5. Total application disruption: ~10 seconds.

The Proxy absorbs the Aurora failover — applications see a brief stall, not a connection reset.

---

## Terraform configuration

```hcl
resource "aws_db_proxy" "winamax_prod" {
  name                   = "winamax-prod-proxy"
  debug_logging          = false
  engine_family          = "MYSQL"
  idle_client_timeout    = 1800  # 30 minutes — close idle application connections
  require_tls            = true
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_security_group_ids = [aws_security_group.rds_proxy.id]
  vpc_subnet_ids         = var.private_subnet_ids

  auth {
    auth_scheme = "SECRETS"
    description = "Aurora credentials"
    iam_auth    = "REQUIRED"   # Enforce IAM auth for application connections
    secret_arn  = aws_secretsmanager_secret.aurora_master.arn
  }
}

resource "aws_db_proxy_default_target_group" "winamax_prod" {
  db_proxy_name = aws_db_proxy.winamax_prod.name

  connection_pool_config {
    connection_borrow_timeout    = 120   # Wait up to 2min for a connection from the pool
    max_connections_percent      = 100   # Use up to 100% of Aurora's max_connections for the pool
    max_idle_connections_percent = 50    # Keep at most 50% of pool as idle connections
  }
}

resource "aws_db_proxy_target" "winamax_prod" {
  db_proxy_name          = aws_db_proxy.winamax_prod.name
  target_group_name      = aws_db_proxy_default_target_group.winamax_prod.name
  db_cluster_identifier  = aws_rds_cluster.winamax_prod.cluster_identifier
}
```

**Security group for the Proxy:**
```hcl
# ECS tasks → Proxy (port 3306)
resource "aws_security_group_rule" "ecs_to_proxy" {
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs_tasks.id
  security_group_id        = aws_security_group.rds_proxy.id
}

# Proxy → Aurora (port 3306)
resource "aws_security_group_rule" "proxy_to_aurora" {
  type                     = "egress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  destination_prefix_list_id = null
  source_security_group_id = aws_security_group.rds_proxy.id
  security_group_id        = aws_security_group.aurora.id
}
```

---

## When NOT to use RDS Proxy

- **Long-running analytical queries:** A Redshift-style analytical query that runs for 5 minutes pins a backend connection for 5 minutes. Use Redshift or Aurora for analytics — not via the Proxy.
- **Very low connection counts:** If you have 5 ECS tasks, RDS Proxy adds latency (one extra network hop) without benefit. Use it when you have enough connections to exhaust Aurora's limit.
- **PostgreSQL-specific features:** RDS Proxy supports MySQL and PostgreSQL but some PostgreSQL features cause pinning. Test first.

---

## Monitoring RDS Proxy

```
DatabaseConnectionsCurrentlyBorrowed  → connections actively being used
DatabaseConnectionsCurrentlySessionPinned → connections pinned (reducing multiplexing)
ClientConnectionsCounts              → application connections to the Proxy
DatabaseConnectionsSetupSucceeded    → successful backend connections

Alert: DatabaseConnectionsCurrentlySessionPinned > 20% of pool
Cause: Application using SET statements, temp tables, or long transactions excessively
Fix: Review application code for session state usage
```
