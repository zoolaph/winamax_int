# Apache Airflow — Operational Basics

Airflow is a workflow orchestration platform. At Winamax, it likely orchestrates data pipelines: extracting data from Aurora, transforming it, loading it to Redshift, triggering AWS Batch jobs, and coordinating multi-step processes that span hours.

---

## Core concepts

### DAG — Directed Acyclic Graph

A DAG is a Python file that defines a workflow. Each node is a task. Edges are dependencies — which tasks must complete before others can start.

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.bash import BashOperator
from datetime import datetime, timedelta

default_args = {
    "owner": "data-platform",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "email_on_failure": True,
    "email": ["sre-oncall@winamax.fr"],
}

with DAG(
    dag_id="bet_settlement_report",
    default_args=default_args,
    schedule_interval="0 6 * * *",    # Daily at 06:00 UTC
    start_date=datetime(2024, 1, 1),
    catchup=False,                     # Do not backfill missed runs
    tags=["reporting", "finance"],
) as dag:
    
    extract_bets = PythonOperator(
        task_id="extract_bets_from_aurora",
        python_callable=extract_settled_bets,
    )
    
    transform = BashOperator(
        task_id="transform_to_parquet",
        bash_command="python /opt/transform/bets_to_parquet.py {{ ds }}",  # {{ ds }} = execution date
    )
    
    load_to_redshift = PythonOperator(
        task_id="load_to_redshift",
        python_callable=copy_parquet_to_redshift,
    )
    
    notify = PythonOperator(
        task_id="send_finance_report",
        python_callable=email_finance_team,
    )
    
    # Define execution order
    extract_bets >> transform >> load_to_redshift >> notify
```

**`catchup=False`:** If the DAG was paused for 5 days and then re-enabled, with `catchup=True` Airflow would schedule 5 missed runs. For a reporting pipeline, that might be correct. For a pipeline that processes "today's data," it would be wrong — always verify.

---

## Operators — what tasks can do

| Operator | What it does |
|----------|-------------|
| `PythonOperator` | Run a Python function |
| `BashOperator` | Run a shell command |
| `ECSOperator` | Run an ECS task (one-off container) |
| `LambdaInvokeFunctionOperator` | Invoke an AWS Lambda |
| `S3ToRedshiftOperator` | COPY data from S3 to Redshift |
| `S3CopyObjectOperator` | Copy objects between S3 paths |
| `AWSBatchOperator` | Submit a job to AWS Batch |
| `EmptyOperator` | No-op, useful for grouping |
| `TriggerDagRunOperator` | Trigger another DAG |

**ECSOperator at Winamax:** Airflow launches a one-off ECS task (a container) for heavy processing work. The ECS task has full access to the production network, IAM roles, and secrets — Airflow just orchestrates the start/stop and monitors the outcome. This keeps heavy computation out of the Airflow workers.

---

## Sensors — waiting for external events

Sensors are tasks that poll until a condition is true. They block a worker slot while waiting.

```python
from airflow.providers.amazon.aws.sensors.s3 import S3KeySensor

wait_for_data_file = S3KeySensor(
    task_id="wait_for_daily_export",
    bucket_name="winamax-data-exports",
    bucket_key="exports/bets/{{ ds }}/bets_settled_*.parquet",
    wildcard_match=True,
    poke_interval=60,       # Check every 60 seconds
    timeout=3600,           # Fail if not found within 1 hour
    mode="reschedule",      # Release worker slot between checks (important!)
)
```

**`mode='reschedule'` is critical:** With `mode='poke'` (default), the worker process holds the slot for the entire polling duration (up to `timeout` seconds). If you have many sensors running simultaneously, you exhaust the worker pool. With `mode='reschedule'`, the sensor yields its worker slot between checks and the scheduler re-queues it. Always use `reschedule` for sensors with long timeouts.

---

## XComs — passing data between tasks

XCom (cross-communication) lets tasks share small values. Do not use XCom for large data — put large data in S3 and pass the path.

```python
def extract_and_count(**context):
    bets = query_aurora("SELECT * FROM bets WHERE date = %s", context["ds"])
    s3_path = upload_to_s3(bets, f"s3://winamax-data-lake/bets/{context['ds']}/")
    
    # Push values to XCom — available to downstream tasks
    context["task_instance"].xcom_push(key="s3_path", value=s3_path)
    context["task_instance"].xcom_push(key="record_count", value=len(bets))
    return s3_path  # Returning also pushes to XCom with key="return_value"

def load_to_redshift(**context):
    # Pull from upstream task
    s3_path = context["task_instance"].xcom_pull(
        task_ids="extract_bets_from_aurora",
        key="s3_path"
    )
    redshift.copy(s3_path)
```

---

## Task dependencies — patterns

```python
# Sequential
task_a >> task_b >> task_c

# Fan-out (task_a triggers both task_b and task_c in parallel)
task_a >> [task_b, task_c]

# Fan-in (task_d starts after both task_b and task_c complete)
[task_b, task_c] >> task_d

# Full pattern: extract → parallel transforms → merge → load
extract >> [transform_bets, transform_users] >> merge >> load
```

---

## Failure handling

### Task-level retries

```python
load_to_redshift = PythonOperator(
    task_id="load_to_redshift",
    python_callable=copy_parquet_to_redshift,
    retries=3,
    retry_delay=timedelta(minutes=10),
    retry_exponential_backoff=True,
    max_retry_delay=timedelta(hours=1),
)
```

### On-failure callbacks

```python
def alert_sre(context):
    # context contains the exception, task info, run info
    send_slack_alert(
        channel="#sre-alerts",
        message=f"DAG {context['dag'].dag_id} task {context['task'].task_id} failed: "
                f"{context['exception']}"
    )

default_args = {
    "on_failure_callback": alert_sre,
}
```

### SLAs — catch slow pipelines

```python
with DAG(
    dag_id="bet_settlement_report",
    sla_miss_callback=alert_sre,
) as dag:
    
    load_to_redshift = PythonOperator(
        task_id="load_to_redshift",
        python_callable=copy_parquet_to_redshift,
        sla=timedelta(hours=2),  # Alert if this task takes more than 2 hours
    )
```

---

## Airflow architecture — what the components are

| Component | Role |
|-----------|------|
| **Scheduler** | Parses DAG files, decides which tasks to run, submits to executor |
| **Executor** | Sends tasks to workers. `CeleryExecutor` uses a task queue (SQS/Redis). `ECSExecutor` runs each task as an ECS task |
| **Workers** | Execute tasks. In `CeleryExecutor`: pool of persistent worker processes |
| **Webserver** | UI for monitoring DAGs, triggering runs, viewing logs |
| **Metadata DB** | PostgreSQL or MySQL — stores DAG runs, task states, XComs |

**At Winamax:** Likely MWAA (Managed Workflows for Apache Airflow on AWS) — reduces the operational burden of managing the scheduler, workers, and metadata DB. MWAA uses `CeleryExecutor` with SQS. You upload DAG files to S3; MWAA syncs them automatically.

---

## Common operational problems

**Problem:** DAG stuck, tasks in `queued` state indefinitely.
**Investigation:** Check worker pool capacity (`airflow workers` or Celery inspect). Is the pool exhausted by stuck sensors (`poke` mode)?

**Problem:** DAG run marked `success` but data is wrong.
**Investigation:** XCom values — did upstream tasks push the expected data? Check task logs. Was `catchup=True` and an old run used stale date parameters?

**Problem:** Scheduler not picking up new DAGs.
**Investigation:** DAG file parse errors — Airflow silently ignores DAGs with Python syntax errors. Check `airflow dags list` and look for import errors. Run `python dag_file.py` locally to check for errors.

**Problem:** Metadata DB growing large.
**Investigation:** Airflow stores every XCom, every task log reference, every DAG run in PostgreSQL. Configure `max_dagruns_to_create_per_loop`, purge old runs with `airflow db clean`.
