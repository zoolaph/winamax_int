# Exercise 4 — Airflow DAG Design

## Scenario

Winamax needs a daily data pipeline that runs at 07:00 UTC every morning. It processes the previous day's settled bets and produces:
1. A Redshift table `finance.daily_bet_summary` (used by the finance team by 09:00)
2. A Parquet file in S3 at `s3://winamax-reports/daily/YYYY-MM-DD/bets_summary.parquet` (consumed by the ML team)
3. A summary email to finance@winamax.fr with key metrics (total bets, total payout, gross gaming revenue)

**Data flow:**
1. Extract settled bets from Aurora (previous day, status='settled')
2. Anonymize user data (replace real user IDs with deterministic hashes for the Parquet output)
3. Load raw data to S3 staging area
4. Run two parallel transforms:
   a. Aggregate for Redshift (GROUP BY sport, market, outcome)
   b. Generate the Parquet file with anonymized data
5. Load aggregated data to Redshift
6. Send summary email once Redshift load is confirmed

---

## Task 1: DAG skeleton

Write the Airflow DAG structure with correct task dependencies. You do not need to implement the Python callables — just define the DAG, tasks, and dependency graph.

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.email import EmailOperator
from datetime import datetime, timedelta

default_args = {
    # Fill in appropriate default_args
}

with DAG(
    dag_id="____________________",
    # Fill in DAG arguments
) as dag:
    
    extract = ____________________
    
    anonymize = ____________________
    
    stage_to_s3 = ____________________
    
    # Two parallel transforms
    aggregate_for_redshift = ____________________
    generate_parquet = ____________________
    
    load_to_redshift = ____________________
    
    send_email = ____________________
    
    # Define dependency graph
    ____________________
```

---

## Task 2: SLA and alerting

The finance team needs the data by 09:00 UTC. The DAG runs at 07:00 UTC. You have 2 hours. The longest historical run took 85 minutes.

Configure:
1. An SLA on the `load_to_redshift` task (it must complete before 08:45 UTC to leave time for email)
2. An on-failure callback that sends a Slack alert to `#data-sre`

```python
def send_slack_alert(context):
    # What information do you include in the alert?
    ____________________

load_to_redshift = PythonOperator(
    task_id="load_to_redshift",
    python_callable=copy_to_redshift,
    sla=____________________,
    on_failure_callback=____________________,
)
```

---

## Task 3: Passing data between tasks

The `extract` task queries Aurora and gets the count of records. The `send_email` task needs to include this count in the email body.

How do you pass the count from `extract` to `send_email`? Write the relevant code in both tasks.

```python
def extract_bets(**context):
    bets = query_aurora(f"SELECT * FROM bets WHERE date = '{context['ds']}' AND status = 'settled'")
    
    # Pass count to downstream tasks
    ____________________
    
    return s3_path

def send_summary_email(**context):
    # Retrieve count from extract task
    record_count = ____________________
    
    # Use in email
    send_email(
        to="finance@winamax.fr",
        subject=f"Daily Bet Summary — {context['ds']}",
        body=f"Settled bets: {record_count}\n..."
    )
```

---

## Task 4: Backfill scenario

The DAG was accidentally paused for 3 days (2024-04-04 through 2024-04-06). The finance team needs all 3 days of data retroactively.

Question A: With `catchup=True` in the DAG definition, what happens when you un-pause the DAG?

Question B: With `catchup=False`, how do you trigger the 3 missing runs manually?

```bash
# Trigger the 3 missing runs
____________________
____________________
____________________
```

Question C: The `aggregate_for_redshift` task runs `INSERT INTO finance.daily_bet_summary`. If you backfill 3 days and one of them was already partially loaded, what happens? What do you add to prevent double-loading?

```sql
-- Safe load query (idempotent)
____________________
```

---

## Task 5: Sensor dependency

The Aurora extract job depends on the previous day's settlement pipeline completing successfully. That pipeline is managed by a different team and a different DAG: `settlement_processor`. It runs nightly and sets a status flag in DynamoDB when complete.

Design the dependency. Should you use:
- A: `ExternalTaskSensor` (wait for the other DAG's task to complete in Airflow)
- B: `S3KeySensor` (wait for a "done" file to appear in S3)
- C: Just start the extract at 07:00 and fail if data is not ready

Explain your choice and the failure mode of each approach.

```
Recommended approach: ____________________

Reason: ____________________

Failure mode of approach A: ____________________
Failure mode of approach B: ____________________
Failure mode of approach C: ____________________
```

---

## Answer Key

### Task 1: DAG skeleton

```python
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.email import EmailOperator
from datetime import datetime, timedelta

default_args = {
    "owner": "data-platform",
    "retries": 2,
    "retry_delay": timedelta(minutes=10),
    "email_on_failure": True,
    "email": ["data-sre@winamax.fr"],
}

with DAG(
    dag_id="daily_bet_summary",
    default_args=default_args,
    schedule_interval="0 7 * * *",    # 07:00 UTC daily
    start_date=datetime(2024, 1, 1),
    catchup=False,
    max_active_runs=1,                 # Prevent overlapping runs
    tags=["finance", "reporting", "daily"],
) as dag:
    
    extract = PythonOperator(
        task_id="extract_bets_from_aurora",
        python_callable=extract_bets,
    )
    
    anonymize = PythonOperator(
        task_id="anonymize_user_data",
        python_callable=anonymize_user_ids,
    )
    
    stage_to_s3 = PythonOperator(
        task_id="stage_to_s3",
        python_callable=upload_to_staging,
    )
    
    aggregate_for_redshift = PythonOperator(
        task_id="aggregate_for_redshift",
        python_callable=build_aggregations,
    )
    
    generate_parquet = PythonOperator(
        task_id="generate_parquet_for_ml",
        python_callable=write_parquet,
    )
    
    load_to_redshift = PythonOperator(
        task_id="load_to_redshift",
        python_callable=copy_to_redshift,
    )
    
    send_email = EmailOperator(
        task_id="send_finance_email",
        to="finance@winamax.fr",
        subject="Daily Bet Summary — {{ ds }}",
        html_content="See attached report for {{ ds }}.",
    )
    
    # Sequential: extract → anonymize → stage to S3
    extract >> anonymize >> stage_to_s3
    
    # Fan-out: stage_to_s3 triggers both parallel transforms
    stage_to_s3 >> [aggregate_for_redshift, generate_parquet]
    
    # Fan-in for Redshift: aggregate must complete before load
    aggregate_for_redshift >> load_to_redshift
    
    # Email after Redshift load (Parquet does not block email)
    load_to_redshift >> send_email
```

### Task 2: SLA and alerting

```python
def send_slack_alert(context):
    dag_id = context["dag"].dag_id
    task_id = context["task"].task_id
    execution_date = context["execution_date"]
    exception = context.get("exception", "Unknown error")
    log_url = context.get("task_instance").log_url
    
    send_slack_message(
        channel="#data-sre",
        text=(
            f":alert: *DAG Failure*\n"
            f"DAG: `{dag_id}`\n"
            f"Task: `{task_id}`\n"
            f"Run date: `{execution_date.date()}`\n"
            f"Error: `{str(exception)[:200]}`\n"
            f"<{log_url}|View logs>"
        )
    )

load_to_redshift = PythonOperator(
    task_id="load_to_redshift",
    python_callable=copy_to_redshift,
    sla=timedelta(hours=1, minutes=45),  # Must complete by 08:45 (07:00 + 1h45m)
    on_failure_callback=send_slack_alert,
)
```

### Task 3: Passing data between tasks

```python
def extract_bets(**context):
    ds = context["ds"]  # Execution date as string: "2024-04-07"
    bets = query_aurora(f"SELECT * FROM bets WHERE DATE(settled_at) = '{ds}' AND status = 'settled'")
    
    s3_path = f"s3://winamax-data-lake/staging/bets/{ds}/bets_raw.parquet"
    upload_to_s3(bets, s3_path)
    
    # Push to XCom — available to all downstream tasks by task_id + key
    context["task_instance"].xcom_push(key="record_count", value=len(bets))
    context["task_instance"].xcom_push(key="s3_path", value=s3_path)
    
    return s3_path  # Also pushed as "return_value"

def send_summary_email(**context):
    ti = context["task_instance"]
    
    # Pull from extract task
    record_count = ti.xcom_pull(task_ids="extract_bets_from_aurora", key="record_count")
    
    send_email(
        to="finance@winamax.fr",
        subject=f"Daily Bet Summary — {context['ds']}",
        body=f"Settled bets processed: {record_count:,}\nReport ready in Redshift: finance.daily_bet_summary"
    )
```

### Task 4: Backfill scenario

**Question A:** With `catchup=True`, Airflow schedules 3 backfill runs (one per missed day: 2024-04-04, 2024-04-05, 2024-04-06) immediately when the DAG is un-paused. They run in parallel (up to `max_active_runs` concurrent DAG runs). If `max_active_runs=1`, they run sequentially oldest-first.

**Question B:** Manual triggers with `catchup=False`:
```bash
airflow dags trigger daily_bet_summary --exec-date 2024-04-04
airflow dags trigger daily_bet_summary --exec-date 2024-04-05
airflow dags trigger daily_bet_summary --exec-date 2024-04-06
```

**Question C:** Idempotent load query:
```sql
-- Delete existing data for the date before inserting (safe for re-runs)
DELETE FROM finance.daily_bet_summary WHERE report_date = '{{ ds }}';
INSERT INTO finance.daily_bet_summary (report_date, sport, market, outcome, total_bets, total_payout)
SELECT '{{ ds }}', sport, market, outcome, COUNT(*), SUM(payout_amount)
FROM staging.bets_{{ ds_nodash }}
GROUP BY sport, market, outcome;

-- Or: use MERGE / UPSERT if supported
-- Redshift supports MERGE since 2023
MERGE INTO finance.daily_bet_summary
USING staging.bets_{{ ds_nodash }} AS src
ON target.report_date = '{{ ds }}' AND target.sport = src.sport ...
WHEN MATCHED THEN UPDATE ...
WHEN NOT MATCHED THEN INSERT ...
```

### Task 5: Sensor dependency

**Recommended approach: B — S3KeySensor**

**Reason:** `ExternalTaskSensor` (Option A) creates tight coupling between two teams' DAGs — the dependency is invisible unless you know to look. If the settlement team renames their DAG or task, your sensor silently fails. An S3 "done" file is a contract — both teams agree on a path, and either side can verify it independently. It is also easier to test (just create the file manually to trigger downstream).

**Failure mode of approach A (ExternalTaskSensor):**
The sensor polls Airflow's metadata DB for the other DAG's task state. If the settlement DAG is renamed, delayed by more than the sensor timeout, or runs in a different Airflow environment, the sensor fails or waits forever. With `mode='poke'`, it holds a worker slot for the entire wait duration.

**Failure mode of approach B (S3KeySensor):**
If the settlement pipeline fails to write the done file, the sensor will wait until timeout (e.g., 2 hours) and then fail the DAG. This is the correct behavior — you want the downstream to fail rather than silently process stale data. The done file should be written atomically (write to `.in_progress` then rename) to avoid a partial-file false positive.

**Failure mode of approach C (start at 07:00 and fail if not ready):**
The extract task fails immediately if yesterday's settlements are not complete. You lose the retry window — you would need a manual re-trigger once the settlement data is ready, which may miss the 09:00 SLA. No visibility into why it failed (data not ready vs. actual bug).
