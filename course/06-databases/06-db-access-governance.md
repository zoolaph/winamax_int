# Database Access Governance — Deep Dive

## Why this is the key Winamax interview topic

The Winamax JD specifically names "automated DB access management across all database types" as an example project. This is not a theoretical topic — they built it. They will ask you how you would design it.

The problem it solves: at 700+ services and dozens of engineers, standing database access is a security and compliance liability. Someone with `SELECT * FROM users` access via a long-lived password can exfiltrate data from their laptop at 2am with no audit trail.

---

## IAM Authentication for Aurora/RDS

Instead of a static `username:password` stored in Secrets Manager, Aurora supports IAM-based authentication. The flow:

```
1. ECS task has a task role with permission: rds-db:connect
2. Application calls RDS API to generate an auth token (valid 15 minutes):
   token = boto3.client('rds').generate_db_auth_token(
       DBHostname='winamax.cluster-xyz.eu-west-3.rds.amazonaws.com',
       Port=3306,
       DBUsername='app_user'
   )
3. Application connects to MySQL using the token as the password:
   mysql -h winamax.cluster-xyz... -u app_user -p{token}
4. Aurora validates the token against IAM — no password stored anywhere
```

**IAM policy for the task role:**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "rds-db:connect",
    "Resource": "arn:aws:rds-db:eu-west-3:123456789:dbuser:cluster-ABCDEFG/app_user"
  }]
}
```

The resource ARN is scoped to the specific cluster AND the specific DB username. The `payment-api` task role can only connect as `payment_user`, not as `admin` or `reporting_user`.

**What this gives you:**
- No password rotation required — the token is ephemeral.
- If the task role is compromised, the attacker has a 15-minute token for one specific DB user. Not a permanent credential.
- CloudTrail logs every `rds-db:connect` call — you know who connected, when, and from which IAM identity.

---

## The Automated Access Request System

This is the system Winamax built. Here is how to design it:

**Problem statement:** A developer needs to investigate a production database issue. They need `SELECT` access to the `bets` table for 2 hours. Today's process: email the DBA, wait for a response, get a shared credential, forget to revoke it.

**Automated solution:**

```
Developer requests access via internal portal:
  - Database: aurora-prod-bets
  - Role: read-only
  - Tables: bets, bet_events
  - Duration: 2 hours
  - Reason: "Investigating bet settlement anomaly for incident INC-2847"

Approval workflow (automated or manager-approved):
  - Check if reason references a valid incident ticket
  - Check if developer's team owns this service
  - Auto-approve for read-only < 4 hours; require manager for write or > 8 hours

Provisioning (Lambda executes):
  CREATE USER 'farouq_temp_20240115_1430'@'%' IDENTIFIED WITH ... ;
  GRANT SELECT ON bets_db.bets TO 'farouq_temp_20240115_1430'@'%';
  GRANT SELECT ON bets_db.bet_events TO 'farouq_temp_20240115_1430'@'%';
  -- Record expiry time in DynamoDB: { user: farouq, expires_at: now + 2h }

Access delivery:
  - Credentials delivered via Secrets Manager (ephemeral secret with 2-hour TTL)
  - Developer retrieves credentials via AWS CLI (their IAM identity is logged)

Cleanup Lambda (runs every 5 minutes):
  - Check DynamoDB for expired access records
  - DROP USER 'farouq_temp_20240115_1430';
  - Delete the Secrets Manager secret
  - Write audit log: who, what, when, how long
```

**Audit trail stored in S3/Quickwit:**
```json
{
  "event": "db_access_granted",
  "user": "farouq.kasah@winamax.fr",
  "iam_identity": "arn:aws:iam::123456789:user/farouq",
  "database": "aurora-prod-bets",
  "tables": ["bets", "bet_events"],
  "access_level": "SELECT",
  "granted_at": "2024-01-15T14:30:00Z",
  "expires_at": "2024-01-15T16:30:00Z",
  "reason": "Investigating bet settlement anomaly INC-2847",
  "approved_by": "auto-approved (read-only < 4h)"
}
```

---

## Break-glass access

For P0 incidents, you cannot wait for an approval workflow.

**Break-glass design:**
1. A specific IAM role (`break-glass-db-admin`) exists with full access.
2. The role can only be assumed by specific principals (on-call SREs).
3. Assuming the role triggers an immediate PagerDuty alert to the security team.
4. All actions during the session are logged to CloudTrail and a tamper-evident S3 bucket.
5. Post-incident: mandatory post-mortem review of what was accessed and why.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "AWS": [
        "arn:aws:iam::123456789:role/oncall-sre-role"
      ]
    },
    "Action": "sts:AssumeRole",
    "Condition": {
      "BoolIfExists": {
        "aws:MultiFactorAuthPresent": "true"
      }
    }
  }]
}
```

MFA is required to assume the break-glass role. This prevents automated compromises — an attacker with a stolen session token cannot assume the role without physical MFA.

**The CloudTrail alert (EventBridge rule):**
```json
{
  "source": ["aws.sts"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventName": ["AssumeRole"],
    "requestParameters": {
      "roleArn": ["arn:aws:iam::123456789:role/break-glass-db-admin"]
    }
  }
}
```
This triggers a Lambda that pages the on-call security engineer immediately.

---

## Audit trails — who accessed what, when

**Three layers of audit:**

**1. Network layer (VPC Flow Logs):**
Captures: source IP, destination IP, port, protocol, bytes. Cannot tell you what SQL was executed. Useful for: "was there an unusual volume of traffic from an unexpected IP to the database endpoint?"

**2. Database layer (Aurora Advanced Auditing):**
Captures: every SQL statement executed, by which user, at what time. Stored in CloudWatch Logs.
```
# Enable in parameter group:
server_audit_logging = 1
server_audit_events = CONNECT,QUERY,QUERY_DML,QUERY_DDL
server_audit_query_log_limit = 10000
```

CloudWatch log entry:
```
20240115 14:35:22,aurora-prod-1,farouq_temp_20240115_1430,10.10.10.45,
4321,123456789,"SELECT bet_id, amount FROM bets WHERE user_id = 'U-12345' LIMIT 100"
```

**3. Application layer:**
Application-level audit logging for sensitive data access — who, what, why, from which service.

**Shipping to Quickwit/S3:**
Aurora audit logs → CloudWatch Logs → Kinesis Firehose → S3 → Quickwit indexed.

Retention: 7 years (French gambling regulation requirement). S3 Glacier after 90 days.

---

## Least-privilege per service

Each ECS service that needs database access gets:
1. Its own DB user with only the privileges it needs.
2. The task role scoped to `rds-db:connect` for that specific DB user.
3. No cross-service DB user sharing.

```sql
-- payment-api gets write access to its tables only
CREATE USER 'payment_api'@'%';
GRANT SELECT, INSERT, UPDATE ON bets_db.bet_slips TO 'payment_api'@'%';
GRANT SELECT, INSERT ON bets_db.payments TO 'payment_api'@'%';
-- No access to users table, no DELETE, no DDL

-- odds-engine gets read access only
CREATE USER 'odds_engine'@'%';
GRANT SELECT ON events_db.odds TO 'odds_engine'@'%';
GRANT SELECT ON events_db.markets TO 'odds_engine'@'%';
```

**Terraform manages DB users:**
```hcl
resource "mysql_user" "payment_api" {
  user               = "payment_api"
  host               = "%"
  auth_plugin        = "AWSAuthenticationPlugin"  # IAM auth
  plaintext_password = ""
}

resource "mysql_grant" "payment_api_bets" {
  user       = mysql_user.payment_api.user
  host       = mysql_user.payment_api.host
  database   = "bets_db"
  table      = "bet_slips"
  privileges = ["SELECT", "INSERT", "UPDATE"]
}
```

DB user creation is now infrastructure-as-code — auditable in git, reviewable in PRs, no manual `GRANT` commands.
