# IAM — Deep Dive

## The core evaluation logic

For any AWS API call, three things must all be true for the action to be **allowed**:

1. The **identity policy** (attached to the caller — user or role) must allow the action.
2. The **resource policy** (on the target — S3 bucket, SQS queue, KMS key) must allow it, OR there is no resource policy (in which case the identity policy alone is sufficient for same-account access).
3. There must be **no explicit Deny** anywhere. An explicit Deny always overrides any Allow.

If none of these conditions explicitly allows the action → **implicit deny** (the default).

```
Effective permission = 
  NOT (any explicit Deny)
  AND (identity policy Allow OR resource policy Allow)
```

---

## Policy types

### Identity-based policies

Attached to users, groups, or roles. Control what that identity can do.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::winamax-traces/*",
      "Condition": {
        "StringEquals": {
          "s3:prefix": ["traces/", "logs/"]
        }
      }
    }
  ]
}
```

### Resource-based policies

Attached to the resource (S3 bucket policy, SQS queue policy, KMS key policy). Specifies who can access the resource.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/ecs-task-role-api"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::winamax-config/*"
    }
  ]
}
```

### Permission boundaries

A permission boundary is a policy that caps the maximum permissions an identity can have. Even if an identity-based policy grants `s3:*`, if the boundary only allows `s3:GetObject`, only `s3:GetObject` is effective.

Used in organizations where a central team controls the boundaries and teams can create their own roles within those limits.

---

## Roles — the core IAM concept for AWS workloads

A role is an IAM identity with **no long-term credentials**. Instead, services assume roles and receive **temporary credentials** (via STS — Security Token Service) that expire after 15 minutes to 12 hours.

### Trust policy

Every role has a trust policy that defines **who can assume it** (the principal).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

This trust policy allows the ECS Tasks service to assume this role — which is what makes ECS task roles work.

### Assuming a role

Any principal with the right trust policy can call `sts:AssumeRole`. They get back:
- `AccessKeyId`
- `SecretAccessKey`
- `SessionToken`
- Expiration timestamp

These are temporary. When they expire, the caller must assume the role again.

**Cross-account assume role:** Role in Account B trusts Account A's role. Account A's role calls `sts:AssumeRole` with the Account B role ARN. This is the standard pattern for cross-account access without sharing credentials.

---

## ECS dual-role pattern (critical for interview)

ECS uses two separate roles per task. Confusing them is the #1 IAM interview trap.

### executionRoleArn

Used by the **ECS Agent** (running on the EC2 host or Fargate control plane) **before the container starts**. The application never uses this role.

Permissions required:
```json
{
  "Action": [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "secretsmanager:GetSecretValue",
    "ssm:GetParameters"
  ]
}
```

**If a task won't start (stuck in PROVISIONING or fails immediately)** → check this role.

### taskRoleArn

Used by the **application code at runtime**, via the ECS Task Metadata endpoint (`http://169.254.170.2/v2/credentials`). The AWS SDK automatically fetches credentials from this endpoint.

Permissions required: whatever the application needs — S3, SQS, DynamoDB, Kafka MSK, etc.

**If the app starts but gets 403 errors on AWS API calls** → check this role.

```
[ECS Agent]
  uses executionRoleArn
  → pulls image from ECR
  → fetches secrets from Secrets Manager
  → writes logs to CloudWatch
  ↓
[Container starts]
  uses taskRoleArn (via http://169.254.170.2)
  → calls S3 for config
  → puts messages on SQS
  → reads from DynamoDB
```

---

## Instance profiles

An instance profile is the mechanism that attaches an IAM role to an EC2 instance. When you launch an EC2 instance with an instance profile, the instance metadata service (`http://169.254.169.254/latest/meta-data/iam/security-credentials/`) provides temporary credentials for that role.

The AWS SDK on the instance automatically picks up these credentials. You never put access keys on an EC2 instance — you use instance profiles.

**For ECS on EC2:** The EC2 instance has an instance profile with permissions needed by the ECS Agent (RegisterContainerInstance, SubmitTaskStateChange, etc.). This is separate from the task role.

---

## Least-privilege in practice

**Start with AWS managed policies for rough shape, then narrow:**

1. Attach `AmazonS3ReadOnlyAccess` to get started.
2. Check CloudTrail to see which specific `s3:Get*` actions are actually called and which buckets.
3. Replace with a custom policy: `s3:GetObject` on `arn:aws:s3:::specific-bucket/*` only.

**Conditions are your friend:**

```json
"Condition": {
  "StringEquals": {
    "aws:RequestedRegion": "eu-west-3"
  }
}
```

This limits the permission to a specific region — even if credentials leak, they can only be used in Paris.

**`NotAction` pattern — careful with this:**

```json
{
  "Effect": "Deny",
  "NotAction": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::winamax-traces/*"
}
```

Denies everything EXCEPT the listed actions. Dangerous if you use it without understanding the evaluation order.

---

## Common IAM interview scenarios

**"A Lambda function is getting AccessDenied when calling DynamoDB. What do you check?"**

1. The Lambda's execution role — does it have `dynamodb:GetItem` (or whatever) on the right table ARN?
2. The DynamoDB table's resource policy — does it have an explicit Deny? (rarely set, but check)
3. Is the Lambda in a VPC? If so, does it have a VPC Endpoint for DynamoDB, or does it have NAT Gateway access to reach the public DynamoDB endpoint?
4. Is there an SCP (Service Control Policy) at the organization level that is denying DynamoDB?

**"How do you give one AWS account access to another account's S3 bucket?"**

Option 1 — Resource policy on the bucket:
```json
{
  "Principal": {"AWS": "arn:aws:iam::ACCOUNT-B:role/service-role"},
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::bucket/*"
}
```
The role in Account B can now access the bucket.

Option 2 — Cross-account role assumption: Account A has a role with S3 permissions. Account B assumes that role via STS. Useful when you want centralized permission management.

**K8s bridge:**

| K8s | AWS |
|--|--|
| ServiceAccount | IAM Role |
| IRSA binding (pod → SA → role) | Instance profile / task role |
| RBAC ClusterRole | IAM managed policy |
| RBAC ClusterRoleBinding | IAM role attachment |
| Namespace-scoped RBAC | IAM resource conditions (prefix, tag) |

The key insight: Kubernetes RBAC controls access to the Kubernetes API. IAM controls access to AWS APIs. In an EKS cluster, both operate simultaneously — RBAC for in-cluster resources, IAM (via IRSA) for AWS resources.
