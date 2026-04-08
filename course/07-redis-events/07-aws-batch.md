# AWS Batch — Deep Dive

AWS Batch manages the compute lifecycle for batch jobs. You define what to run (job definition), where to run it (compute environment), and in what order (job queue). AWS handles instance provisioning, scaling from zero, job scheduling, and cleanup.

---

## Core components

### Compute Environment

The pool of compute capacity that runs jobs. Two types:

**EC2 compute environment (managed):**
```hcl
resource "aws_batch_compute_environment" "batch_workers" {
  compute_environment_name = "winamax-batch-workers"
  type                     = "MANAGED"
  
  compute_resources {
    type                = "SPOT"           # Use Spot for cost savings on batch workloads
    allocation_strategy = "SPOT_CAPACITY_OPTIMIZED"  # Pick instance type least likely to be interrupted
    
    instance_type = ["m5.xlarge", "m5.2xlarge", "m4.xlarge"]  # Multiple types = better Spot availability
    
    min_vcpus     = 0      # Scale to zero when idle (no standing cost)
    max_vcpus     = 256    # Maximum parallelism
    desired_vcpus = 0      # Start from zero
    
    spot_iam_fleet_role = aws_iam_role.spot_fleet.arn
    instance_role       = aws_iam_instance_profile.batch_instance.arn
    
    subnets            = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.batch.id]
  }
  
  service_role = aws_iam_role.batch_service.arn
}
```

**Fargate compute environment:**
```hcl
resource "aws_batch_compute_environment" "batch_fargate" {
  compute_environment_name = "winamax-batch-fargate"
  type                     = "MANAGED"
  
  compute_resources {
    type      = "FARGATE_SPOT"    # Fargate Spot for cost savings
    max_vcpus = 128
    
    subnets            = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_group_ids = [aws_security_group.batch.id]
  }
}
```

**EC2 vs Fargate for Batch:**

| | EC2 | Fargate |
|--|-----|---------|
| Startup time | ~2–5 minutes (instance boot) | ~30–60 seconds |
| GPU support | Yes | No |
| Custom AMI | Yes | No |
| Cost at scale | Cheaper (Spot discounts) | Pay-per-vCPU-second, no Spot for long jobs |
| Use case | Long-running ML jobs, heavy data processing | Short, sporadic jobs, no warm pool needed |

---

### Job Queue

A queue has a priority and maps to one or more compute environments. Multiple queues can share a compute environment.

```hcl
resource "aws_batch_job_queue" "high_priority" {
  name     = "winamax-batch-high"
  state    = "ENABLED"
  priority = 100    # Higher number = higher priority
  
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.batch_fargate.arn   # Try Fargate first
  }
  compute_environment_order {
    order               = 2
    compute_environment = aws_batch_compute_environment.batch_workers.arn   # Fall back to EC2 Spot
  }
}

resource "aws_batch_job_queue" "low_priority" {
  name     = "winamax-batch-low"
  state    = "ENABLED"
  priority = 10
  
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.batch_workers.arn
  }
}
```

---

### Job Definition

The blueprint for a job — container image, resource requirements, IAM role, environment variables, retry strategy.

```hcl
resource "aws_batch_job_definition" "report_generator" {
  name = "winamax-report-generator"
  type = "container"
  
  container_properties = jsonencode({
    image   = "123456789.dkr.ecr.eu-west-3.amazonaws.com/report-generator:latest"
    jobRoleArn = aws_iam_role.batch_job.arn
    
    resourceRequirements = [
      { type = "VCPU",   value = "2" },
      { type = "MEMORY", value = "4096" }
    ]
    
    environment = [
      { name = "AURORA_HOST",   value = var.aurora_endpoint },
      { name = "S3_OUTPUT_BUCKET", value = var.reports_bucket },
    ]
    
    secrets = [
      {
        name      = "DB_PASSWORD"
        valueFrom = "arn:aws:secretsmanager:eu-west-3:123456789:secret:aurora-password"
      }
    ]
    
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/aws/batch/winamax-report-generator"
        "awslogs-region"        = "eu-west-3"
        "awslogs-stream-prefix" = "batch"
      }
    }
  })
  
  retry_strategy {
    attempts = 3
    evaluate_on_exit {
      on_status_reason = "Host EC2 .* terminated"  # Spot interruption → retry
      action           = "RETRY"
    }
    evaluate_on_exit {
      on_reason = "CannotPullContainerError:*"  # Image pull failure → retry
      action    = "RETRY"
    }
    evaluate_on_exit {
      on_exit_code = "1"    # Application error → do not retry
      action       = "FAILED"
    }
  }
}
```

---

### Array Jobs — parallel processing

An array job is a single job definition that spawns N parallel children. Each child gets `AWS_BATCH_JOB_ARRAY_INDEX` (0 to N-1) as an environment variable.

**Use case:** Process 100 CSV files in parallel. Each child processes one file based on its index.

```python
# Inside the container
import os
import boto3

array_index = int(os.environ["AWS_BATCH_JOB_ARRAY_INDEX"])
array_size = int(os.environ["AWS_BATCH_JOB_ARRAY_SIZE"])

# List all files, each job processes its chunk
s3 = boto3.client("s3")
response = s3.list_objects_v2(Bucket="winamax-data-exports", Prefix="bets/2024-01/")
all_files = [obj["Key"] for obj in response["Contents"]]
my_files = all_files[array_index::array_size]  # Slice: every Nth file starting at index

for file_key in my_files:
    process_file(file_key)
```

Submit the array job:
```bash
aws batch submit-job \
  --job-name "bet-reports-jan-2024" \
  --job-queue winamax-batch-high \
  --job-definition winamax-report-generator \
  --array-properties size=100    # 100 parallel children
```

---

## Job Dependencies

Jobs can depend on other jobs completing successfully.

```bash
# Submit extract job
EXTRACT_JOB_ID=$(aws batch submit-job \
  --job-name "extract-bets" \
  --job-queue winamax-batch-high \
  --job-definition extract-job \
  --query "jobId" --output text)

# Submit transform job that waits for extract to succeed
aws batch submit-job \
  --job-name "transform-bets" \
  --job-queue winamax-batch-high \
  --job-definition transform-job \
  --depends-on jobId=$EXTRACT_JOB_ID,type=SEQUENTIAL
```

For array jobs, `type=N_TO_N` means child N of the transform job waits for child N of the extract job — useful for parallel pipelines where each file is extracted then transformed independently.

---

## The decision framework — Lambda vs Batch vs Airflow+ECS

```
Does the job need to run longer than 15 minutes?
  YES → Batch or Airflow+ECS (not Lambda)
  NO  → Lambda is simplest

Does the job need GPU or > 30GB memory?
  YES → Batch on EC2
  NO  → continue

Is the job triggered by an event (S3 upload, API call)?
  YES → Lambda, or Lambda submitting a Batch job
  NO  → continue

Does the job have multiple steps with dependencies?
  YES → Airflow (orchestrates Batch + ECS + Lambda)
  NO  → Batch job with retry strategy

Does the job need to process N files in parallel?
  YES → Batch array job
  NO  → Single Batch job
```

**Winamax-specific patterns:**

| Use case | Tool |
|----------|------|
| Settle bets at end of match (5–30 min) | AWS Batch |
| Generate daily finance reports (1–2 hours) | Airflow → Batch |
| Process user data export requests (30 seconds) | Lambda |
| Full ETL pipeline: Aurora → S3 → Redshift (3 hours) | Airflow DAG with ECSOperator + S3ToRedshiftOperator |
| ML model retraining on historical bet data | Batch on EC2 GPU instance |
| Ingest live odds feed into Kafka (always on) | ECS Service (not Batch — Batch is for finite jobs) |

---

## Monitoring and operational runbook

**Check job status:**
```bash
aws batch describe-jobs --jobs $JOB_ID
aws batch list-jobs --job-queue winamax-batch-high --job-status RUNNING
```

**Job stuck in RUNNABLE — not starting:**
Causes: no compute capacity available (Spot unavailable for the instance types, or `maxvCPUs` reached). Check:
```bash
aws batch describe-compute-environments --compute-environments winamax-batch-workers
# Look at: status, statusReason, computeResources.desiredvCpus
```

**Spot interruption handling:**
Jobs on Spot instances can be interrupted at any time. The `retry_strategy` with `on_status_reason = "Host EC2 .* terminated"` automatically retries interrupted jobs. Design jobs to be restartable — checkpoint progress to S3, pick up where you left off.

**Failed job investigation:**
```bash
# Get log stream name from job description
aws batch describe-jobs --jobs $JOB_ID --query "jobs[0].container.logStreamName"

# Read CloudWatch logs
aws logs get-log-events \
  --log-group-name /aws/batch/winamax-report-generator \
  --log-stream-name $LOG_STREAM_NAME \
  --start-from-head
```
