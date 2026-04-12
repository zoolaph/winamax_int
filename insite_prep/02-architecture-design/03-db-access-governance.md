# Architecture Design 03 — Ephemeral Database Access System

## Set the timer: 10 minutes. Close your notes.

---

## The constraints

- 700 microservices access ~40 Aurora databases
- Current state: shared `admin` credentials in a 1Password vault, no audit trail, access never revoked
- CNIL audit: critical finding — human access to production data is not tracked or time-limited
- Requirements:
  - Self-service for developers (no DBA bottleneck)
  - Access must expire automatically — no manual revocation
  - Audit trail must be tamper-evident and retained 7 years
  - READ-only access: auto-approved, max 4 hours
  - WRITE access: manager approval required, max 8 hours
  - Break-glass for P0 incidents: immediate access, with controls
  - No long-lived shared credentials anywhere

**Design the full system. Include:**
1. The request → approval → provision → expire flow
2. Every AWS component you use and why
3. The IAM policy for the provisioning Lambda
4. The break-glass procedure
5. How you answer the CNIL auditor: "show me every human who accessed database X in the last 90 days"

---

**STOP. Design it now.**

---
---
---
---
---
---

## Reference design

### Full flow diagram

```
Developer                      Governance System                    AWS
──────────                     ─────────────────                    ───

Slack: /db-access              API Gateway + Lambda
  db: aurora-prod-bets         (Request Handler)
  tables: bets, users     ──►  - Validate request               DynamoDB: AccessRequests
  level: SELECT                - Check policy (is dev allowed    { requestId, requester,
  duration: 2h                   to access this db?)               db, tables, level,
  reason: INC-2847             - Write request record              duration, status: PENDING,
                               - If read + ≤4h: auto-approve       expiresAt, reason }
                               - Else: Slack DM to manager

Manager approves         ──►  Slack Action Handler
[Approve] in Slack             Lambda
                               - Update status: APPROVED
                               - Emit EventBridge event

APPROVED event           ──►  Provisioning Lambda
  (EventBridge)                - Generate username: farouq_bets_20260412_1430
                               - Generate random 32-char password
                               - Connect to Aurora as db_provisioner (IAM auth)
                               - EXECUTE: CREATE USER 'farouq_bets_...' IDENTIFIED BY '...'
                               - EXECUTE: GRANT SELECT ON bets.* TO 'farouq_bets_...'
                               - Store credentials in Secrets Manager:
                                   /ephemeral/db/farouq_bets_20260412_1430
                               - Grant developer IAM identity read access to this one secret
                               - Update DynamoDB: status=ACTIVE
                               - Write to S3 audit log:
                                   { event: access_granted, user, db, tables, level,
                                     expires_at, approved_by, request_id }

Developer retrieves      ──►  aws secretsmanager get-secret-value
credentials                     --secret-id /ephemeral/db/farouq_bets_...
(CloudTrail logs this           (CloudTrail logs: who retrieved, when, from where)
IAM call automatically)

------- 2 hours later -------

EventBridge scheduled    ──►  Cleanup Lambda (runs every 5 min)
rule fires                     - Query DynamoDB for records where expiresAt < now()
                               - For each expired record:
                                   - Connect to Aurora as db_provisioner
                                   - EXECUTE: DROP USER IF EXISTS 'farouq_bets_...'
                                   - Delete Secrets Manager secret
                                   - Remove developer's IAM access to the secret
                                   - Update DynamoDB: status=EXPIRED
                                   - Write to S3 audit log: { event: access_revoked, ... }
```

### IAM policy for Provisioning Lambda

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadApprovalState",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:eu-west-3:123456789:table/DBAccessRequests"
    },
    {
      "Sid": "ManageEphemeralSecrets",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:TagResource"
      ],
      "Resource": "arn:aws:secretsmanager:eu-west-3:123456789:secret:winamax/ephemeral/db/*"
    },
    {
      "Sid": "GrantDeveloperSecretAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:PutResourcePolicy"
      ],
      "Resource": "arn:aws:secretsmanager:eu-west-3:123456789:secret:winamax/ephemeral/db/*"
    },
    {
      "Sid": "ConnectToAuroraAsProvisioner",
      "Effect": "Allow",
      "Action": ["rds-db:connect"],
      "Resource": "arn:aws:rds-db:eu-west-3:123456789:dbuser:*/db_provisioner"
    },
    {
      "Sid": "WriteAuditLog",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::winamax-db-audit-logs/access-events/*"
    },
    {
      "Sid": "KMSForSecrets",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:eu-west-3:123456789:key/ephemeral-secrets-cmk"
    }
  ]
}
```

Key design: the `db_provisioner` Aurora user has only `GRANT OPTION` on the tables it manages — not superuser. Even if the Lambda is compromised, the attacker can only create limited-privilege users, not execute arbitrary SQL or read data directly.

### Break-glass procedure

**Design goal:** immediate access for P0 incidents with zero bottleneck, but with automatic alerting and full audit trail.

```
1. SRE assumes break-glass role (requires MFA)
   aws sts assume-role \
     --role-arn arn:aws:iam::123456789:role/BreakGlassDBAdmin \
     --role-session-name "P0-INC-2847-$(whoami)-$(date +%s)" \
     --serial-number arn:aws:iam::123456789:mfa/farouq.kasah \
     --token-code 123456

2. AssumeRole event triggers EventBridge rule immediately
   → SNS → PagerDuty alert to security team
   → Slack message: "@security-team break-glass DB access by farouq — INC-2847"

3. SRE retrieves master credentials
   aws secretsmanager get-secret-value \
     --secret-id winamax/aurora-prod/master-break-glass
   (CloudTrail logs this retrieval)

4. Aurora Advanced Auditing captures every SQL statement during the session
   → Kinesis Firehose → S3 in real time

5. After incident:
   - Rotate master password within 24 hours (break-glass access ends)
   - Post-mortem review of every query run during the session
   - Was any data accessed beyond what the incident required?
   - If yes: escalate to security investigation
```

Controls that prevent abuse:
- MFA required — stolen session tokens are insufficient
- Automatic alert to security team fires within seconds — cannot be silenced by the user
- Session name encodes who, when, and incident ID — visible in CloudTrail
- Master password rotated after use — break-glass cannot be reused silently

### Answering the CNIL auditor

"Show me every human who accessed database aurora-prod-bets in the last 90 days."

```sql
-- Query against S3 audit logs via Athena
SELECT
  event_time,
  requester_email,
  access_level,
  tables_accessed,
  approved_by,
  reason,
  access_duration_minutes,
  expiry_time
FROM db_access_audit_logs
WHERE
  database_name = 'aurora-prod-bets'
  AND event_type = 'access_granted'
  AND access_source = 'human'
  AND event_date BETWEEN DATE_ADD('day', -90, CURRENT_DATE) AND CURRENT_DATE
ORDER BY event_time DESC;

-- Cross-reference with Aurora audit log for actual queries run
SELECT
  event_time,
  db_user,
  client_ip,
  command_type,
  argument AS sql_statement
FROM aurora_audit_logs
WHERE
  partition_date >= DATE_ADD('day', -90, CURRENT_DATE)
  AND db_user NOT LIKE '%_service'
  AND command_type IN ('QUERY', 'QUERY_DML', 'CONNECT')
ORDER BY event_time DESC;
```

The S3 bucket has Object Lock in compliance mode — 7-year retention. You can prove to the CNIL that no log has been modified or deleted since it was written.

### Why this design is solid

1. **No long-lived credentials** — every access grant generates a unique user that expires. The shared `admin` credential is eliminated.
2. **Least privilege** — a developer gets SELECT on the specific tables they requested, not the entire database.
3. **Automatic expiry** — the cleanup Lambda runs every 5 minutes. No human forgets to revoke access.
4. **Full audit trail** — three independent layers: DynamoDB (request state), S3 (structured events), Aurora audit log (query-level), CloudTrail (credential retrieval). All tamper-evident via Object Lock.
5. **Self-service** — no DBA bottleneck. Read-only access is instant. The friction is only on write access where it should be.
