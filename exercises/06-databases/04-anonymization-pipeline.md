# Exercise 4 — Design the Prod-to-Staging Data Pipeline

## Scenario

Winamax's staging environment is running 4-month-old production data. A critical bug was missed in staging because the data volume and distribution were unrepresentative of production. The engineering director has asked you to build an automated, weekly pipeline that refreshes staging with a recent, anonymized subset of production data.

Production database:
- Aurora MySQL, 50 TB across 12 tables
- Contains 5M user accounts, 330M bet records, 50M payment records
- Data is subject to GDPR (CNIL jurisdiction — French)

Staging environment:
- Aurora MySQL, smaller instance class (max 5 TB)
- 30 engineers have access
- Staging has its own S3 buckets, DynamoDB tables, etc. (different AWS account)

---

## Task 1: Identify what must be anonymized

For each column type, decide: anonymize, generalize, drop, or keep.

| Column | Data type | Decision | Method |
|--------|-----------|----------|--------|
| user_id | UUID | ________ | ________ |
| email | String | ________ | ________ |
| first_name | String | ________ | ________ |
| last_name | String | ________ | ________ |
| phone | String | ________ | ________ |
| date_of_birth | Date | ________ | ________ |
| national_id | String | ________ | ________ |
| iban | String | ________ | ________ |
| ip_address | String | ________ | ________ |
| bet_amount | Decimal | ________ | ________ |
| bet_status | Enum | ________ | ________ |
| sport_type | String | ________ | ________ |
| event_id | UUID | ________ | ________ |
| created_at | Timestamp | ________ | ________ |

---

## Task 2: Subset strategy

You need to bring 50 TB down to under 5 TB (staging instance limit). Describe your sampling strategy:

1. Which table do you sample first (the "anchor" table)?
2. How do you ensure referential integrity for dependent tables?
3. What percentage gives you a representative sample?
4. How do you ensure the sample is consistent across runs (same users each week, not a different random set each time)?

---

## Task 3: Pipeline design

Design the complete pipeline architecture using AWS services. Include:
- Where the pipeline runs
- What services it uses for each step
- How long it should take (SLA)
- How it handles failures

```
Step 1: ____________________
Step 2: ____________________
Step 3: ____________________
Step 4: ____________________
Step 5: ____________________
```

---

## Task 4: Validation

Before the refreshed staging database is made available to engineers, you need to validate the pipeline output. Write 5 validation checks:

```
Check 1: ____________________  Pass condition: ____________________
Check 2: ____________________  Pass condition: ____________________
Check 3: ____________________  Pass condition: ____________________
Check 4: ____________________  Pass condition: ____________________
Check 5: ____________________  Pass condition: ____________________
```

---

## Task 5: Cross-account data movement

The production database is in Account A. Staging is in Account B. How do you securely move the anonymized data across accounts?

---

## Answer Key

### Task 1: Anonymization decisions

| Column | Decision | Method |
|--------|----------|--------|
| user_id | **Keep** (deterministic) | user_id is internal — keep it. Relational integrity depends on it. |
| email | **Anonymize** | `sha256(email + SALT)[:16]@anon.winamax.fr` — deterministic, irreversible |
| first_name | **Replace** | Random French first name from Faker |
| last_name | **Replace** | Random French last name from Faker |
| phone | **Replace** | `+33600000000` (static placeholder — not deterministic, but phone isn't a join key) |
| date_of_birth | **Generalize** | Keep year only (e.g., `1988-01-01`). Age matters for regulatory (18+); exact birthday does not. |
| national_id | **Drop** | Cannot be anonymized safely — too specific, too risky. Remove the column entirely. |
| iban | **Anonymize** | Keep country code (FR), replace rest: `FR` + `sha256(iban + SALT)[:22]`. Format preserved. |
| ip_address | **Anonymize** | Keep first 2 octets (geographic region), zero the rest: `192.168.0.0`. |
| bet_amount | **Keep** | Financial amounts — the distribution is important for testing. Amounts alone without user identity are not PII. |
| bet_status | **Keep** | Non-PII operational data |
| sport_type | **Keep** | Non-PII |
| event_id | **Keep** | Internal reference — non-PII |
| created_at | **Keep** | Timestamps are important for testing time-based logic |

**Key principle:** `user_id` is kept as-is because it is a synthetic internal key (UUID), not tied to identity. The anonymization of `email`, `name`, `phone`, etc. means that even if you have the `user_id`, you cannot identify the real person.

### Task 2: Subset strategy

```
1. Anchor table: users
   Start with users because all other tables (bets, payments, sessions) have a FK to user_id.
   Sample the users table first; then inner-join all dependent tables to the sampled user set.

2. Referential integrity:
   sampled_users = users WHERE ABS(HASH(user_id)) % 10 = 0  -- 10% of users
   sampled_bets = bets WHERE user_id IN (SELECT user_id FROM sampled_users)
   sampled_payments = payments WHERE user_id IN (SELECT user_id FROM sampled_users)
   -- All records for sampled users are included; no orphaned records.

3. 10% sampling:
   5M users × 10% = 500K users
   330M bets × (500K/5M average) = ~33M bets
   50M payments × 10% = ~5M payments
   Estimated size: 50 TB × 10% = ~5 TB (fits staging limit)

4. Consistent sampling:
   Use HASH(user_id) % 10 = 0 — not RAND().
   The hash of a given user_id is always the same.
   Run this week: same 500K users as last week.
   This matters: engineers debugging a specific user's behavior can bookmark that user_id
   and it will always be in staging.
```

### Task 3: Pipeline architecture

```
Step 1: Snapshot (10 min)
  Trigger: EventBridge weekly schedule (Sunday 02:00 UTC, low-traffic)
  Action: aws rds create-db-cluster-snapshot
  Service: Lambda (calls RDS API)
  Output: Snapshot ARN stored in DynamoDB pipeline state table

Step 2: Export snapshot to S3 (2-4 hours for 50 TB)
  Action: aws rds start-export-task (native Aurora Parquet export to S3)
  Output: s3://winamax-prod-export-temp/YYYY-MM-DD/ (Parquet files, prod account)
  Note: Export bucket in prod account, KMS encrypted

Step 3: Anonymize and subset (1-2 hours)
  Service: AWS Glue (PySpark job)
  Input: s3://winamax-prod-export-temp/YYYY-MM-DD/
  Output: s3://winamax-prod-export-temp/YYYY-MM-DD/anonymized/
  Actions:
    - Load each table
    - Apply anonymization UDFs
    - Filter to sampled user set
    - Write anonymized Parquet back to S3

Step 4: Cross-account copy (30 min for ~5 TB)
  Service: S3 Cross-Region/Cross-Account Copy via S3 replication or aws s3 sync
  Mechanism: S3 bucket policy on staging account bucket allows s3:PutObject from prod account
             IAM role in prod account has s3:GetObject on source, s3:PutObject on destination
  Source: s3://winamax-prod-export-temp/YYYY-MM-DD/anonymized/ (prod account)
  Destination: s3://winamax-staging-import/YYYY-MM-DD/ (staging account)
  Note: Data is anonymized BEFORE cross-account copy — PII never leaves prod account

Step 5: Load to staging Aurora (30-60 min)
  Service: Lambda triggers aws rds restore-db-instance-from-s3 or DMS task
  Alternative: Aurora native S3 import (LOAD DATA FROM S3)
  Post-load: Run validation Lambda (Task 4 checks)
  On success: Notify #engineering-infra Slack channel with row counts and timing
  On failure: Alert on-call engineer, leave existing staging DB untouched

Total pipeline SLA: ~5 hours. Runs Sunday overnight — staging is ready Monday morning.
```

**Failure handling:**
- Each step writes its status to a DynamoDB pipeline state table.
- If any step fails, the pipeline stops and alerts. It does not partially overwrite staging.
- The export temp bucket has a 7-day lifecycle rule — exports are automatically cleaned up.

### Task 4: Validation checks

```
Check 1: Row count sanity
  Query: SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM bets;
  Pass condition: users between 450K and 550K (10% ± 10%); bets proportionally sampled

Check 2: No PII present — spot check email column
  Query: SELECT email FROM users LIMIT 100
  Pass condition: All emails match pattern @anon.winamax.fr, no real email addresses

Check 3: Referential integrity
  Query: SELECT COUNT(*) FROM bets b LEFT JOIN users u ON b.user_id = u.user_id WHERE u.user_id IS NULL
  Pass condition: 0 orphaned bets (every bet has a corresponding user)

Check 4: National ID column removed
  Query: DESCRIBE users;
  Pass condition: no national_id column in schema

Check 5: Statistical distribution preserved
  Query: SELECT sport_type, COUNT(*) / (SELECT COUNT(*) FROM bets) as pct FROM bets GROUP BY sport_type
  Pass condition: football is top sport (>40%), distribution matches production ratios within ±5%
  (This validates that the sample is representative, not biased toward certain sports)
```

### Task 5: Cross-account data movement

**Approach: S3 Cross-Account with resource policy**

In prod account, the export bucket has a policy allowing staging to read it:
```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::STAGING-ACCOUNT-ID:role/staging-db-import"
    },
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::winamax-prod-export-temp/*/anonymized/*",
      "arn:aws:s3:::winamax-prod-export-temp"
    ]
  }]
}
```

**The staging import role** assumes in staging account and calls `aws s3 sync` to pull anonymized data. Data flows: prod S3 → staging S3. The KMS key for the source bucket must also allow the staging account to decrypt.

**Why not copy raw data and anonymize in staging?**
Because that would mean raw PII temporarily exists in the staging account — a lower-security environment with 30 engineers. Anonymize first, then move.

**Alternative: AWS Data Exchange or direct S3 cross-account replication** — but the approach above gives more control over exactly which data crosses the account boundary.
