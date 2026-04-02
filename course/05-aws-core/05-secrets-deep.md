# Secrets Manager vs SSM Parameter Store — Deep Dive

## The decision rule

**Secrets Manager** — use when the value is a credential that should rotate automatically. Database passwords, API keys, OAuth secrets.

**SSM Parameter Store** — use for everything else. Configuration values, feature flags, service endpoints, non-rotating credentials (when rotation is handled externally), paths and settings that change per environment.

If in doubt: ask "does this value need to rotate on a schedule without human intervention?" Yes → Secrets Manager. No → SSM Parameter Store.

---

## AWS Secrets Manager

### What it stores

Any key-value or JSON blob, stored encrypted (KMS). Designed primarily for credentials.

```json
{
  "username": "winamax_app",
  "password": "s3cur3-r4nd0m-p4ss",
  "engine": "postgres",
  "host": "winamax-db.xxxxx.eu-west-3.rds.amazonaws.com",
  "port": 5432,
  "dbname": "winamax_prod"
}
```

RDS integration: Secrets Manager can store the full RDS connection bundle.

### Automatic rotation

Secrets Manager can automatically rotate credentials on a schedule using a Lambda function.

```
Secret: winamax-rds-prod-password
  Rotation:
    Enabled: true
    Rotation Lambda: arn:aws:lambda:...:secrets-manager-rds-rotation
    Rotation schedule: every 30 days
```

The rotation Lambda:
1. Creates a new password on the database.
2. Updates the secret in Secrets Manager.
3. Tests the new credentials.
4. If test passes: marks old credentials for cleanup.

For RDS, AWS provides managed rotation Lambda functions. For custom credentials (Kafka, third-party APIs), you write the Lambda.

**Application impact:** Applications using the AWS SDK call `GetSecretValue` at startup or per-request. If they cache the secret and rotation happens, they hit 401s until they re-fetch. Best practice: catch authentication errors and re-fetch the secret rather than caching indefinitely. RDS Proxy helps here — it handles the rotation transparently.

### Cost

~$0.40/secret/month + $0.05 per 10,000 API calls.

At 100 secrets: $40/month. At 1,000 secrets: $400/month. Cost is real but justified for credentials that need rotation.

### Cross-account

Secrets Manager supports cross-account access via resource policies on the secret and IAM roles. A secret in Account A can be read by a role in Account B.

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::ACCOUNT-B:role/ecs-task-role"},
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "*"
  }]
}
```

---

## SSM Parameter Store

### What it stores

Parameters are individual values (String, StringList, or SecureString). Organized by path hierarchy.

```
/winamax/prod/api/database-url
/winamax/prod/api/redis-endpoint
/winamax/prod/api/kafka-brokers
/winamax/prod/feature-flags/new-odds-engine
/winamax/staging/api/database-url
```

### Parameter types

| Type | Encrypted | Use case |
|--|--|--|
| String | No | Non-sensitive config (URLs, region names) |
| StringList | No | Comma-separated lists |
| SecureString | Yes (KMS) | Sensitive values, API keys without rotation |

### Standard vs Advanced parameters

| | Standard | Advanced |
|--|--|--|
| Size | 4KB max | 8KB max |
| Cost | Free | $0.05/parameter/month |
| Parameter policies | No | Yes (TTL, rotation notification) |
| Higher throughput | No | Yes |

Standard parameters are free up to 10,000 requests/month, then $0.05/10,000 requests. For most workloads at startup (not per-request), this is effectively free.

### GetParametersByPath

Fetch all parameters under a prefix in one call — useful for loading all env config at startup:

```
GetParametersByPath:
  Path: /winamax/prod/api/
  WithDecryption: true
  Recursive: true

Returns:
  /winamax/prod/api/database-url → postgres://...
  /winamax/prod/api/redis-endpoint → redis://...
  /winamax/prod/api/kafka-brokers → broker1:9092,broker2:9092
```

---

## ECS integration pattern

Both services integrate natively with ECS task definitions via the `secrets` field:

```json
{
  "containerDefinitions": [{
    "name": "api",
    "secrets": [
      {
        "name": "DATABASE_PASSWORD",
        "valueFrom": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:winamax-rds-prod-password"
      },
      {
        "name": "REDIS_ENDPOINT",
        "valueFrom": "arn:aws:ssm:eu-west-3:123456789012:parameter/winamax/prod/api/redis-endpoint"
      },
      {
        "name": "KAFKA_BROKERS",
        "valueFrom": "arn:aws:ssm:eu-west-3:123456789012:parameter/winamax/prod/api/kafka-brokers"
      }
    ]
  }]
}
```

**How it works at runtime:**
1. ECS Agent uses the `executionRoleArn` to call `secretsmanager:GetSecretValue` or `ssm:GetParameters`.
2. The resolved values are injected as environment variables into the container.
3. The application reads them as normal env vars — no AWS SDK call needed in the app itself.
4. The `taskRoleArn` does NOT need secrets permissions (the executionRole handles it).

**Limitation:** Secrets are injected at task startup. If the secret rotates while the task is running, the in-memory env var is stale. The task must restart to pick up the new value. For database passwords, use the AWS SDK + RDS Proxy to handle rotation transparently at the connection level.

---

## Secrets Manager vs SSM: side-by-side

| | Secrets Manager | SSM Parameter Store |
|--|--|--|
| Primary purpose | Credential management | Configuration management |
| Automatic rotation | Yes (Lambda-based) | No (manual) |
| Cost | $0.40/secret/month | Free (Standard) |
| Max size | 65KB | 4KB (Standard), 8KB (Advanced) |
| Cross-account | Native support | Complex |
| Versioning | Multiple versions, AWSPREVIOUS/AWSCURRENT labels | Up to 100 versions |
| Parameter hierarchy | No (flat name with /) | Yes (GetParametersByPath) |
| Integration with ECS | Yes | Yes |
| Audit (CloudTrail) | Yes | Yes |

---

## Production patterns at Winamax (inferred)

1. **Database credentials** → Secrets Manager with automatic rotation. RDS Proxy handles the rotation window for active connections.

2. **Kafka credentials (SASL/TLS)** → Secrets Manager (credentials, rotation possible).

3. **Feature flags, service config, environment-specific URLs** → SSM Parameter Store (free, hierarchical, loaded at startup).

4. **Third-party API keys (payment processor, OAuth)** → Secrets Manager (sensitive, should rotate).

5. **Terraform state** → neither — Terraform uses a dedicated S3 backend with DynamoDB locking. But Terraform reads from SSM/Secrets Manager when provisioning resources that need these values.

**Interview angle:** "How do you handle secret rotation without downtime?" → Secrets Manager rotation Lambda updates the secret, RDS Proxy handles the in-flight connection pool and rotates transparently. Applications using direct connections should catch authentication exceptions and retry with a fresh `GetSecretValue` call. Set a short max connection lifetime so connections naturally rotate.
