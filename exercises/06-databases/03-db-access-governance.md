# Exercise 3 — Design the Ephemeral DB Access System

## Scenario

You are designing Winamax's automated database access governance system. The current state:
- 40 engineers have direct DB access via shared `admin` credentials stored in a shared 1Password vault.
- There is no audit trail of who connected when or what queries they ran.
- Access is never revoked — an engineer who left 6 months ago still has the credentials.
- The CNIL audit found this as a critical finding.

Your task: design a system that provides developers with just-in-time, time-limited, least-privilege database access — with full auditability.

---

## Task 1: Requirements gathering

Before designing, list the requirements this system must satisfy:

**Functional requirements** (what it must do):
```
1. ____________________
2. ____________________
3. ____________________
4. ____________________
5. ____________________
```

**Security requirements** (what it must prevent):
```
1. ____________________
2. ____________________
3. ____________________
```

**Compliance requirements** (what it must prove):
```
1. ____________________
2. ____________________
```

---

## Task 2: System architecture

Draw (in text/ASCII) the architecture of the access request and provisioning flow.

The system should handle:
- A developer requesting access via a Slack command `/db-access request`
- Approval (automated for read-only < 4h, manual for write or > 8h)
- Provisioning of a temporary DB user
- Credential delivery to the developer
- Automatic revocation at expiry

---

## Task 3: IAM policy design

Write the IAM policy for the provisioning Lambda's role. It needs to:
- Read the approval status from a DynamoDB table
- Create and drop DB users in Aurora (via Systems Manager Session Manager or direct RDS API)
- Read and write to Secrets Manager (to create and delete ephemeral credentials)
- Write audit logs to an S3 bucket

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "____",
      "Effect": "Allow",
      "Action": [____],
      "Resource": "____"
    },
    {
      "Sid": "____",
      "Effect": "Allow",
      "Action": [____],
      "Resource": "____"
    }
  ]
}
```

---

## Task 4: Break-glass design

An incident occurs at 3am. The on-call SRE needs immediate full Aurora access. The normal request flow takes 5 minutes minimum (even with auto-approval).

Design the break-glass procedure:
1. How does the SRE get elevated access immediately?
2. What controls prevent abuse?
3. What audit trail is created?
4. What happens after the incident?

---

## Task 5: Audit query

The CNIL audit asks: "Show us every time your production database was accessed by a human in the last 90 days, including what queries were run."

Write the Athena query against your S3 audit log to answer this:

```sql
SELECT ____
FROM ____
WHERE ____
ORDER BY ____
LIMIT 1000;
```

---

## Answer Key

### Task 1: Requirements

**Functional:**
```
1. Developer can request DB access via self-service (Slack, internal portal, or CLI)
2. Access request specifies: database, privilege level, tables, and duration
3. Approval is automated for low-risk requests, manual for high-risk
4. Approved access is provisioned automatically — no DBA manual work
5. Access expires automatically at the requested time — no manual revocation needed
```

**Security:**
```
1. No long-lived shared credentials — every access grant uses a unique ephemeral user
2. Minimum privilege — READ access cannot be escalated to WRITE without a new request
3. No developer can access a database for a service outside their team without approval
```

**Compliance:**
```
1. Every access grant, every query executed, and every credential retrieval is logged immutably
2. Audit logs are retained for 7 years (French gambling regulation) and tamper-evident (S3 Object Lock)
```

### Task 2: Architecture

```
Developer                  Governance System              AWS
────────                   ─────────────────              ───

/db-access request ──────► API Gateway + Lambda           DynamoDB:
  db: aurora-prod-bets       (Request Handler)     ──────► AccessRequests table
  tables: bets               - Validates request            { requestId, user, db,
  level: SELECT              - Creates request record         tables, level, duration,
  duration: 2h               - Posts to Slack for approval    status: PENDING }
  reason: INC-2847           - Auto-approves if eligible

Manager clicks ──────────► Slack Action Handler     ──────► Update request to APPROVED
[Approve] in Slack           Lambda
                                                    
APPROVED event ──────────► Provisioning Lambda      ──────► Aurora: CREATE USER, GRANT
  (EventBridge)              - Creates ephemeral DB user    Secrets Manager: create secret
                             - Stores creds in SM             { user: farouq_temp_xxx
                             - Sends creds to developer         password: <random>
                             - Records in audit log             expires: now+2h }
                             - Schedules cleanup               S3 audit log: append

Developer retrieves ─────► aws secretsmanager get-secret-value  (IAM logged in CloudTrail)
  credentials               (their IAM identity is logged)

After 2 hours ───────────► Cleanup Lambda           ──────► Aurora: DROP USER farouq_temp_xxx
  (EventBridge scheduled)    (polls DynamoDB for             Secrets Manager: delete secret
                              expired records)               S3 audit log: access_revoked event
```

### Task 3: IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadApprovalState",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
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
      "Sid": "WriteAuditLog",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::winamax-db-audit-logs/*"
    },
    {
      "Sid": "ConnectToAuroraForProvisioning",
      "Effect": "Allow",
      "Action": [
        "rds-db:connect"
      ],
      "Resource": "arn:aws:rds-db:eu-west-3:123456789:dbuser:cluster-ABCDEF/db_provisioner"
    },
    {
      "Sid": "KMSForSecrets",
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:eu-west-3:123456789:key/ephemeral-secrets-key"
    }
  ]
}
```

Note: The Lambda connects to Aurora as a privileged `db_provisioner` user (via IAM auth) to execute `CREATE USER` and `GRANT`. This user has only `GRANT OPTION` on the tables it manages — not superuser privileges.

### Task 4: Break-glass

**Immediate access:**
```bash
# 1. SRE assumes the break-glass role (requires MFA)
aws sts assume-role \
  --role-arn arn:aws:iam::123456789:role/break-glass-db-admin \
  --role-session-name "incident-P0-INC-2847-$(whoami)" \
  --serial-number arn:aws:iam::123456789:mfa/farouq.kasah \
  --token-code 123456

# 2. Retrieve the master DB credentials
aws secretsmanager get-secret-value \
  --secret-id winamax/aurora-prod/master
```

**Controls:**
- MFA required to assume the break-glass role (prevents stolen session tokens from working).
- The role is not listed in normal IAM role lists — access to the ARN is itself restricted.
- AssumeRole call triggers EventBridge rule → SNS → PagerDuty alert to security team immediately.
- All actions during the session are in CloudTrail under the role session name.
- The master credentials in Secrets Manager require an additional IAM permission not granted to normal roles.

**Audit trail:**
- CloudTrail: `AssumeRole` event for the break-glass role.
- CloudTrail: `GetSecretValue` for the master secret.
- Aurora Advanced Auditing: every SQL statement executed by the master user during this session.
- S3 (Kinesis Firehose): real-time stream of the Aurora audit log.
- Mandatory incident ticket update: the on-call SRE must link the break-glass event to an incident within 15 minutes.

**Post-incident:**
- Within 24 hours: rotate the master DB password (break-glass access ends).
- Post-mortem review of every query executed during the session — did the SRE access data beyond what was needed?
- If data beyond the incident scope was accessed: escalate to security investigation.
- Update the incident runbook to prevent the next break-glass event from being necessary.

### Task 5: Athena query

Assuming the S3 audit log is Parquet/JSON partitioned by date:

```sql
SELECT
  event_time,
  developer_email,
  database_name,
  access_level,
  tables_accessed,
  reason,
  approved_by,
  session_duration_minutes,
  queries_executed_count
FROM db_access_audit_logs
WHERE
  event_type IN ('access_granted', 'query_executed', 'access_revoked')
  AND event_date BETWEEN DATE_ADD('day', -90, CURRENT_DATE) AND CURRENT_DATE
  AND access_source = 'human'   -- Excludes service account (ECS task) access
ORDER BY event_time DESC
LIMIT 1000;
```

For the Aurora query-level log (from Aurora Advanced Auditing → S3):
```sql
SELECT
  event_time,
  db_user,
  client_ip,
  command_type,
  argument as sql_statement
FROM aurora_audit_logs
WHERE
  partition_date BETWEEN DATE_ADD('day', -90, CURRENT_DATE) AND CURRENT_DATE
  AND command_type IN ('QUERY', 'QUERY_DML', 'QUERY_DDL', 'CONNECT', 'DISCONNECT')
  AND db_user NOT LIKE '%_service'  -- Exclude service accounts
ORDER BY event_time DESC;
```
