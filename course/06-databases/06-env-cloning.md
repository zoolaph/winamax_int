# Environment Cloning with Anonymization — Deep Dive

## The problem

Winamax's staging environment must be realistic enough to catch bugs before they reach production. A staging environment with 100 fake users and 1,000 synthetic bets will not reproduce the edge cases that emerge from 5 million users and 900k bets/day.

But the production database contains:
- Full names, email addresses, phone numbers (PII under GDPR)
- IBAN and payment card identifiers
- National ID and identity verification data
- Bet history (can reveal financial behavior and personal habits)
- IP addresses and device fingerprints

Copying this to a lower-security staging environment without anonymization is a GDPR violation. A breach of staging data is still a data breach.

**Goal:** Staging looks statistically like production (same cardinality, same data distribution, same relational integrity) but contains no recoverable real user data.

---

## The anonymization pipeline

```
Aurora Prod  →  Export  →  Anonymize  →  Load  →  Aurora Staging
(50 TB)          (S3)      (Glue/Lambda)  (S3)    (representative subset)
```

### Step 1: Export from production

Do not run the pipeline against the live writer. Use the Aurora read replica or a snapshot:

```bash
# Create a snapshot first — no production impact
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier winamax-prod \
  --db-cluster-snapshot-identifier winamax-prod-$(date +%Y%m%d)

# Restore snapshot to a temporary cluster for export
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier winamax-export-temp \
  --snapshot-identifier winamax-prod-20240115

# Export to S3 via Aurora export (Parquet format)
aws rds start-export-task \
  --export-task-identifier winamax-export-20240115 \
  --source-arn arn:aws:rds:eu-west-3:123456789:cluster-snapshot:winamax-prod-20240115 \
  --s3-bucket-name winamax-db-exports \
  --s3-prefix exports/20240115 \
  --iam-role-arn arn:aws:iam::123456789:role/rds-export-role \
  --kms-key-id arn:aws:kms:eu-west-3:123456789:key/xxx
```

### Step 2: Anonymization

Run AWS Glue (PySpark) or Lambda against the exported Parquet files in S3.

**Anonymization functions:**

```python
import hashlib
import re
from faker import Faker

fake = Faker('fr_FR')  # French locale for realistic dummy data
SALT = os.environ['ANONYMIZATION_SALT']  # Stored in Secrets Manager, constant per environment

def anonymize_email(email: str) -> str:
    """Deterministic — same input always produces same output.
    Preserves relational integrity (same user referenced in multiple tables)."""
    hashed = hashlib.sha256((email + SALT).encode()).hexdigest()[:16]
    domain = email.split('@')[1] if '@' in email else 'unknown.com'
    return f"{hashed}@anon.{domain}"

def anonymize_name(name: str) -> str:
    """Non-deterministic — generates a realistic French name."""
    return fake.name()

def anonymize_iban(iban: str) -> str:
    """Preserve country code and format, replace with fake account number."""
    country = iban[:2]  # FR, DE, etc.
    return country + fake.iban()[2:]

def anonymize_ip(ip: str) -> str:
    """Hash the IP — same IP maps to same anonymized IP (preserves analytics)."""
    hashed = hashlib.sha256((ip + SALT).encode()).hexdigest()
    # Build an IPv4 from first 8 hex chars
    parts = [int(hashed[i:i+2], 16) for i in range(0, 8, 2)]
    return '.'.join(str(p) for p in parts)

def generalize_amount(amount: float) -> float:
    """Round financial amounts — preserves statistical distribution, reduces precision."""
    if amount < 1:
        return round(amount, 1)
    elif amount < 100:
        return round(amount)
    else:
        return round(amount / 10) * 10
```

**Glue job — process the users table:**
```python
# Glue PySpark transformation
from pyspark.sql import functions as F
from pyspark.sql.types import StringType

anonymize_email_udf = F.udf(anonymize_email, StringType())
anonymize_name_udf  = F.udf(anonymize_name,  StringType())
anonymize_ip_udf    = F.udf(anonymize_ip,    StringType())

users_df = spark.read.parquet("s3://winamax-db-exports/users/")

anonymized = users_df \
    .withColumn("email",      anonymize_email_udf(F.col("email"))) \
    .withColumn("first_name", anonymize_name_udf(F.col("first_name"))) \
    .withColumn("last_name",  anonymize_name_udf(F.col("last_name"))) \
    .withColumn("phone",      F.lit("+33600000000")) \
    .withColumn("iban",       anonymize_iban_udf(F.col("iban"))) \
    .withColumn("ip_address", anonymize_ip_udf(F.col("ip_address"))) \
    .drop("national_id", "id_document_path")  # Drop columns that cannot be anonymized safely

anonymized.write.parquet("s3://winamax-staging-data/users/", mode="overwrite")
```

### Step 3: Subset selection

Production has 50 TB. You do not need all of it in staging. The goal is representative, not complete.

**Consistent subsampling:**
```python
# Take 10% of users — but keep ALL their related data (bets, payments, events)
# Use hash of user_id to get a consistent 10% sample (not random each run)
sampled_users = users_df.filter(
    F.abs(F.hash(F.col("user_id"))) % 10 == 0  # Consistent 10% subset
)

# Then filter all other tables to only include records for sampled users
bets_df = spark.read.parquet("s3://winamax-db-exports/bets/")
sampled_bets = bets_df.join(sampled_users.select("user_id"), on="user_id", how="inner")
```

This gives you 5 TB instead of 50 TB while preserving relational integrity — every bet has a corresponding user.

### Step 4: Load to staging Aurora

```bash
# Restore anonymized data to staging Aurora
aws rds restore-db-cluster-from-s3 \
  --db-cluster-identifier winamax-staging \
  --source-engine mysql \
  --source-engine-version 8.0 \
  --s3-bucket-name winamax-staging-data \
  --s3-ingestion-role-arn arn:aws:iam::123456789:role/rds-s3-import-role
```

---

## What deterministic anonymization preserves

**Without determinism:**
- `farouq@winamax.fr` → `abc123@anon.fr` in the users table
- `farouq@winamax.fr` → `xyz789@anon.fr` in the payments table  
- The staging FK relationship is broken — you cannot join users to their payments.

**With deterministic anonymization (same input → same output):**
- `farouq@winamax.fr` → `a1b2c3d4e5f6a7b8@anon.winamax.fr` in both tables.
- Every table that references this email always gets the same hash.
- Joins work. Relational integrity is preserved.

The SALT ensures the hashes are not reversible by looking up the SHA256 of known emails from public data breaches.

---

## CNIL and GDPR compliance checklist

Before shipping staging data to a less-secure environment:

- [ ] All direct identifiers removed or anonymized: name, email, phone, national ID, IBAN
- [ ] All indirect identifiers generalized: exact IP → hashed, exact amount → rounded
- [ ] Sensitive categories explicitly addressed: political opinions, health data, financial behavior
- [ ] Anonymization is irreversible: cannot reconstruct original data from anonymized version
- [ ] Anonymization key (SALT) stored separately and not accessible in staging environment
- [ ] Data minimization: only the columns and rows needed for testing are exported
- [ ] Access to the anonymization pipeline output is restricted (separate S3 bucket, separate IAM role)
- [ ] Audit log of every cloning operation: who triggered it, what was included, when

---

## Automation and scheduling

The cloning pipeline runs on a schedule (weekly or on-demand via a ChatOps command):

```
/clone-staging-db --source prod --subset 10% --confirm
```

The `confirm` flag ensures no accidental triggering. The pipeline:
1. Creates a production snapshot.
2. Runs the Glue anonymization job.
3. Loads to staging Aurora.
4. Runs a validation job (row count checks, FK integrity checks, anonymization spot-checks).
5. Notifies the requesting engineer in Slack: "Staging DB refresh complete — 4.8 TB loaded."

The staging DB is never more than 1 week stale, so engineers always have realistic data.
