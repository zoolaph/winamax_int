# Exercise 2 — IAM Policy Debugging

## Scenario A: ECS task won't start

An ECS task for the `payments-api` service is stuck in `PROVISIONING`. The ECS event log shows:

```
ResourceInitializationError: unable to pull secrets or registry auth:
execution resource retrieval failed: unable to retrieve secret from asm:
AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/ecs-execution-role-payments/xxx
is not authorized to perform: secretsmanager:GetSecretValue
on resource: arn:aws:secretsmanager:eu-west-3:123456789012:secret:winamax-payments-db-prod
```

**Questions:**
1. Which IAM role is missing the permission?
2. Write the minimal IAM policy statement to fix it.
3. After fixing this, the task still won't start — now CloudWatch shows it can't pull the image. What do you check next?

---

## Scenario B: App gets 403 on S3

The `api` service starts successfully but logs show:

```
ERROR: AccessDenied: Access Denied for s3:GetObject on winamax-config-prod/api/config.json
  at Request.extractError (request.js:452:11)
  role: arn:aws:iam::123456789012:role/ecs-task-role-api
```

**The task role policy currently is:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": "arn:aws:s3:::winamax-config-prod"
    }
  ]
}
```

**Questions:**
1. What is wrong with this policy?
2. Write the corrected policy.
3. What is the S3 bucket policy on `winamax-config-prod`? You check and find it has Block Public Access enabled and no explicit bucket policy. Does this explain the 403? What is the correct explanation?

---

## Scenario C: Cross-account access failure

Winamax has two accounts: `prod` (123456789012) and `shared-services` (999888777666). A secret in `shared-services` (`arn:aws:secretsmanager:eu-west-3:999888777666:secret:winamax-kafka-credentials`) needs to be read by an ECS task in `prod`.

Current setup:
- ECS task in `prod` has `executionRoleArn`: `arn:aws:iam::123456789012:role/ecs-execution-role`
- That role has `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:eu-west-3:123456789012:secret:*`

**Questions:**
1. Why can't the task read the secret in `shared-services`?
2. List the two changes needed to make this work.
3. Write the resource policy to add to the secret in `shared-services`.

---

## Answer Key

### Scenario A

1. The **executionRole** is missing the permission. This is the role used by the ECS Agent before the container starts. The error shows `assumed-role/ecs-execution-role-payments` — not the task role.

2. Add to the execution role policy:
```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:winamax-payments-db-prod*"
}
```
Note the trailing `*` — Secrets Manager appends a random suffix to the ARN. Without it, the ARN won't match.

3. For the image pull failure, check:
   - Does the execution role have `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`?
   - Does the task's subnet have connectivity to ECR? (NAT GW or VPC Endpoint)
   - Does the task's security group allow outbound 443?

### Scenario B

1. The policy grants `s3:*` on the **bucket** ARN (`arn:aws:s3:::winamax-config-prod`) but NOT on the **objects** inside it. `s3:GetObject` operates on `arn:aws:s3:::bucket/key`, not on `arn:aws:s3:::bucket`.

2. Corrected policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::winamax-config-prod/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::winamax-config-prod"
    }
  ]
}
```
`s3:ListBucket` requires the bucket ARN. `s3:GetObject` requires the objects ARN (`bucket/*`). Common to need both.

3. The no-bucket-policy + Block Public Access situation does NOT cause the 403. Block Public Access only restricts public access (unauthenticated requests). For authenticated IAM requests within the same account, the identity policy alone is sufficient when there is no bucket policy. The real cause was the incorrect ARN in the identity policy (Scenario B question 1 above).

### Scenario C

1. The execution role's `secretsmanager:GetSecretValue` permission is scoped to `arn:aws:secretsmanager:eu-west-3:123456789012:secret:*` — the `prod` account only. The secret is in account `999888777666`.

2. Two changes needed:
   - **Change 1:** Update the execution role policy in `prod` to allow `secretsmanager:GetSecretValue` on the specific secret ARN in `shared-services`:
   ```json
   {
     "Effect": "Allow",
     "Action": "secretsmanager:GetSecretValue",
     "Resource": "arn:aws:secretsmanager:eu-west-3:999888777666:secret:winamax-kafka-credentials*"
   }
   ```
   - **Change 2:** Add a resource policy to the secret in `shared-services` allowing the prod execution role:

3. Resource policy on the secret in `shared-services`:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "AWS": "arn:aws:iam::123456789012:role/ecs-execution-role"
    },
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "*"
  }]
}
```

Both the identity policy AND the resource policy must allow the action for cross-account access. Either alone is insufficient.
