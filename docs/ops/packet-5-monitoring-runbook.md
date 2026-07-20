# Packet 5 G3 Monitoring Runbook

> Created: 2026-07-20 (Scope 3 docs/runbook closure)
> Scope 1 (creation): `Operator\twinpet-p1-offline-sync-packet-5-g3-monitoring-policy-creation-report.md` — `POLICY CREATION COMPLETE`
> Scope 2 (independent verification): `reviewer\twinpet-p1-offline-sync-packet-5-g3-monitoring-policy-verification-report.md` — `PASS WITH NOTES`
> Cost exactification: `Architect\twinpet-p1-offline-sync-packet-5-g3-monitoring-cost-exactification-report.md` — `COST EXACTIFICATION COMPLETE`

---

## 1. Overview

Packet 5 G3 monitoring observes the deployed Packet 5 shift-close evidence capture / source-event routing / validation sweep / adjudication pipeline (`shiftCloseEvidenceCapture`, the four `shiftCloseSourceEvent*` triggers, `shiftCloseValidationSweep`, `resolveShiftCloseAlert`) on project `twinpet-pos`, region `asia-southeast1`, database `pos-db`.

**This monitoring does not change runtime behavior.** It is Cloud Monitoring/Logging configuration only — one email notification channel, two log-based metrics, eight alert policies. No application code, Firestore rule, index, or Cloud Function was modified to create it.

---

## 2. Resource inventory

### 2.1 Notification channel

| Field | Value |
|---|---|
| Resource | `projects/twinpet-pos/notificationChannels/1890505988171137697` |
| Display name | `Twinpet P5 G3 Owner Email` |
| Type | `email` |
| Recipient | `narachat.damg@gmail.com` |
| Enabled | `true` |

### 2.2 Log-based metrics (exactly two)

| Metric | Backs | Purpose |
|---|---|---|
| `twinpet_p5_g3_sweep_heartbeat` | A6 | Counts hourly `sweep_invocation_summary` log lines from `shiftclosevalidationsweep`, used to detect a missing sweep run |
| `twinpet_p5_g3_crash_startup_failure` | A7 | Counts `STARTUP TCP probe failed` log lines across all seven Packet 5 Cloud Run services |

A1–A5 and A8 intentionally have **no** log-based metric (cost-hygiene amendment — see §3).

### 2.3 Alert policies (all eight enabled)

| ID | Policy ID | Condition type | Severity | Scope |
|---|---|---|---|---|
| A1 | `18167201681152046266` | log-match | CRITICAL | `shiftcloseevidencecapture` |
| A2 | `12389370263747388327` | log-match | ERROR | `shiftcloseevidencecapture` |
| A3 | `12389370263747390940` | log-match | CRITICAL | `shiftcloseevidencecapture`, `shiftclosevalidationsweep` |
| A4 | `9737851729068377850` | log-match | ERROR | 4 source-event services |
| A5 | `12389370263747389716` | log-match | CRITICAL | `resolveshiftclosealert` |
| A6 | `9737851729068378283` | metric absence (7500s / 125 min) | ERROR | `shiftclosevalidationsweep` |
| A7 | `15369544350227750525` | metric threshold (>2 / 10 min, per service) | CRITICAL | all 7 Cloud Run services |
| A8 | `9737851729068376946` | built-in metric threshold (>10 / 15 min, per function) | ERROR | all 7 Cloud Functions |

Every policy attaches exactly one notification channel (the email channel in §2.1).

**Severity mapping note:** the source pack specified `HIGH` for A2/A4/A6/A8. The Cloud Monitoring `AlertPolicy.severity` enum only accepts `SEVERITY_UNSPECIFIED`, `CRITICAL`, `ERROR`, `WARNING`. `HIGH` was mapped to the nearest valid value, `ERROR`. This was reviewed and accepted in Scope 2 as an API constraint, not a discretionary downgrade.

### 2.4 Exact filters / conditions

**A1 — Capture Permanent Error** (log-match, rate limit 300s)
```
resource.type="cloud_run_revision" AND resource.labels.location="asia-southeast1" AND resource.labels.service_name="shiftcloseevidencecapture" AND textPayload:"capture_transaction_error_permanent"
```

**A2 — Capture Refusal** (log-match, rate limit 900s)
```
resource.type="cloud_run_revision" AND resource.labels.location="asia-southeast1" AND resource.labels.service_name="shiftcloseevidencecapture" AND textPayload:"capture_refused_"
```

**A3 — Capture/Worker Anomaly** (log-match, rate limit 300s)
```
resource.type="cloud_run_revision" AND resource.labels.location="asia-southeast1" AND resource.labels.service_name=("shiftcloseevidencecapture" OR "shiftclosevalidationsweep") AND (textPayload:"capture_anomaly_" OR textPayload:"worker_anomaly_")
```

**A4 — Source Event Permanent Error** (log-match, rate limit 900s)
```
resource.type="cloud_run_revision" AND resource.labels.location="asia-southeast1" AND resource.labels.service_name=("shiftclosesourceeventasyncorders" OR "shiftclosesourceeventorders" OR "shiftclosesourceeventcashtransactions" OR "shiftclosesourceeventcreditpayments") AND textPayload:"source_event_transaction_error_permanent"
```
Uses the current token `source_event_transaction_error_permanent`. **Does not** use the stale token `enqueue_refused_branch_mismatch` from earlier trackers — that token is not emitted by shipped code.

**A5 — Adjudication Server Error** (log-match, rate limit 300s)
```
resource.type="cloud_run_revision" AND resource.labels.location="asia-southeast1" AND resource.labels.service_name="resolveshiftclosealert" AND textPayload:"unexpected error"
```
Deliberately service-scoped rather than using the full bracketed token `[resolveShiftCloseAlert] unexpected error`, because bracket tokenization in the Logging filter grammar could not be validated read-only (no live matching entry exists yet, and synthesizing one is forbidden). The service scope makes this safe today: only `resolveShiftCloseAlert` runs in that Cloud Run service. **Re-review this filter if the service's logging surface expands** (see §6).

**A6 — Sweep Heartbeat Missing** (metric absence)
```
filter:          resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/twinpet_p5_g3_sweep_heartbeat"
duration:        7500s (125 minutes)
alignmentPeriod: 600s, ALIGN_SUM, REDUCE_SUM
```
Scheduler job `firebase-schedule-shiftCloseValidationSweep-asia-southeast1` runs every 60 minutes; a 125-minute absence window tolerates exactly one missed run and fires on two.

**A7 — Crash Startup Failure** (metric threshold)
```
filter:      resource.type="cloud_run_revision" AND metric.type="logging.googleapis.com/user/twinpet_p5_g3_crash_startup_failure"
comparison:  COMPARISON_GT, threshold 2, duration 0s
aggregation: 600s ALIGN_SUM / REDUCE_SUM, grouped by resource.label.service_name
```
Grouped per Cloud Run service — the threshold applies per-service, not summed across all seven.

**A8 — Retry Loop Signature** (built-in metric threshold)
```
filter:      metric.type="cloudfunctions.googleapis.com/function/execution_count" AND resource.type="cloud_function" AND metric.label.status!="ok" AND resource.label.function_name=one_of("shiftCloseEvidenceCapture","shiftCloseSourceEventAsyncOrders","shiftCloseSourceEventOrders","shiftCloseSourceEventCashTransactions","shiftCloseSourceEventCreditPayments","shiftCloseValidationSweep","resolveShiftCloseAlert")
comparison:  COMPARISON_GT, threshold 10, duration 0s
aggregation: 900s ALIGN_SUM / REDUCE_SUM, grouped by resource.label.function_name
```
Uses the built-in Cloud Functions metric (`cloud_function` resource, camelCase `function_name` labels) — a deliberate asymmetry from A1–A7's lowercase Cloud Run `service_name` labels, empirically confirmed correct in both Scope 1 and Scope 2.

---

## 3. Cost-hygiene design

- A1–A5 use native log-match alert conditions and have **no** backing log-based metric — log-match conditions return no points and incur no metric-reference or points charge.
- A6 and A7 are the **only** custom log-based metrics (2 total, not 7).
- A8 uses the **built-in** `cloudfunctions.googleapis.com/function/execution_count` metric — no custom metric needed.
- Resource caps respected exactly: 1 email notification channel, 2 log-based metrics, 8 alert policies, 0 dashboards.
- Cost exactification found the expected cost is negligible: **USD 0.00/month** while Cloud Monitoring alerting remains unbilled (no sooner than 2026-09-01), then roughly **USD 1.05–1.50/month** (≈THB 39–49) once alerting billing begins, against ≈THB 9,751.22 of free-trial credit as of 2026-07-20.
- **Free-trial expiry (≈2026-08-27) is a separate owner decision** — see §7. It is not resolved by this monitoring docs closure.

---

## 4. Alert response procedures

General rule for every alert below: **investigate read-only first.** Do not manually edit `shiftCloseCases`, `shiftCloseAlerts`, `shiftCloseAuditEvents`, `shiftCloseAdjudicationCommands`, or `shifts` documents, and do not redeploy, recapture, disable triggers, or force-run the scheduler without separate Gemini/Owner authorization.

### A1 — Capture Permanent Error

- **Meaning:** `shiftCloseEvidenceCapture` hit a permanent (non-retryable) error while capturing shift-close evidence.
- **First checks (read-only):** review `shiftcloseevidencecapture` Cloud Run logs around the alert window; identify the shift ID / branch ID / error message.
- **Evidence to collect:** shift ID, branch ID, timestamp, full error/stack from the log entry.
- **Escalation:** if the failure pattern repeats or affects multiple shifts, escalate to the Owner/Gemini authority before any remediation.
- **Prohibited:** do not manually edit shift, evidence, or case documents; do not recapture.

### A2 — Capture Refusal

- **Meaning:** `shiftCloseEvidenceCapture` refused to capture (a `capture_refused_*` code) — e.g. invalid shift, malformed `closedAt`, malformed mirror field, invalid total bills, payload over limit.
- **First checks:** find the specific `capture_refused_*` code in the log line to determine which validation failed.
- **Evidence to collect:** refusal code, shift ID, source document shape if loggable.
- **Escalation:** if refusals cluster around one branch/device, escalate — may indicate a client-side data-quality bug.
- **Prohibited:** do not manually recapture; do not hand-edit the source document to force a pass.

### A3 — Capture/Worker Anomaly

- **Meaning:** `capture_anomaly_*` (from `shiftCloseEvidenceCapture`) or `worker_anomaly_*` (from `shiftCloseValidationSweep`) — an unexpected internal state was detected.
- **First checks:** read the anomaly log line and the related `shiftCloseCases`/`shiftCloseAlerts` document state (read-only).
- **Evidence to collect:** anomaly code, shift/case ID, case version, alert state.
- **Escalation:** escalate before any mutation — anomalies indicate the validation state machine encountered something it didn't expect.
- **Prohibited:** no direct document mutation without separate authorization.

### A4 — Source Event Permanent Error

- **Meaning:** one of the four source-event triggers (`shiftCloseSourceEventAsyncOrders`/`Orders`/`CashTransactions`/`CreditPayments`) hit a permanent error routing a source document into `shiftCloseCases`.
- **First checks:** review the specific source-event service's logs for `source_event_transaction_error_permanent`. **Do not** search for the stale token `enqueue_refused_branch_mismatch` — it is not emitted by shipped code.
- **Evidence to collect:** source collection/document ID, shift ID, error detail.
- **Escalation:** escalate if errors recur for the same source collection.
- **Prohibited:** no manual `shiftCloseCases` edits; no re-enqueue.

### A5 — Adjudication Server Error

- **Meaning:** `resolveShiftCloseAlert` logged an `unexpected error` — an unhandled path in the manager adjudication callable.
- **First checks:** review `resolveshiftclosealert` logs for the `unexpected error` line and surrounding context/stack.
- **Evidence to collect:** the manager's request context (shift/case ID, `commandId` if present), the error detail.
- **Note:** the filter uses a service-scoped generic token (`unexpected error`) because the bracketed token's tokenization behavior was never test-fired (no live traffic to validate against). **If the `resolveshiftclosealert` logging surface expands to include another `unexpected error` log line, re-review this filter** for false-positive risk.
- **Prohibited:** no manual adjudication-document mutation.

### A6 — Sweep Heartbeat Missing

- **Meaning:** the hourly `shiftCloseValidationSweep` scheduled run has not emitted its `sweep_invocation_summary` heartbeat log for 125 minutes (tolerates one missed run, fires on two).
- **First checks:** check Cloud Scheduler job `firebase-schedule-shiftCloseValidationSweep-asia-southeast1` state/last-run; check `shiftclosevalidationsweep` Cloud Run revision health; check whether the hourly heartbeat has actually stopped in Cloud Logging.
- **Evidence to collect:** scheduler job state, last successful invocation time, Cloud Run revision status/errors.
- **Prohibited:** do not force-run the scheduler unless separately authorized.

### A7 — Crash Startup Failure

- **Meaning:** more than 2 `STARTUP TCP probe failed` events in 10 minutes on a single Cloud Run service (evaluated per service).
- **First checks:** review Cloud Run revision history/logs for the affected service for startup crash detail (missing env var, dependency failure, etc.).
- **Evidence to collect:** affected service name, failing revision ID, startup error detail.
- **Prohibited:** do not redeploy without authorization.

### A8 — Retry Loop Signature

- **Meaning:** more than 10 non-`ok`-status executions in 15 minutes on a single Cloud Function (built-in `execution_count` metric, evaluated per function) — a possible retry storm.
- **First checks:** identify the failing function from `resource.label.function_name`; review its logs for the recurring failure and the `status` label value.
- **Evidence to collect:** function name, status label, count, surrounding log entries showing the repeated failure.
- **Prohibited:** do not disable the function's trigger or mutate data without separate authorization.

---

## 5. Read-only command examples

Safe, read-only inspection commands (no create/update/delete/test-fire/invoke/deploy):

```bash
gcloud monitoring policies list --project=twinpet-pos
gcloud logging metrics list --project=twinpet-pos
gcloud beta monitoring channels list --project=twinpet-pos
gcloud run services list --region=asia-southeast1 --project=twinpet-pos
firebase functions:list --project twinpet-pos
```

Reading logs for a specific service in a time window (read-only):

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="shiftcloseevidencecapture"' \
  --project=twinpet-pos --limit=50 --format=json
```

Reading a specific alert policy's live definition (read-only):

```bash
gcloud monitoring policies describe projects/twinpet-pos/alertPolicies/18167201681152046266 --project=twinpet-pos
```

Do **not** run `gcloud monitoring policies create/update/delete`, `gcloud logging metrics create/update/delete`, `gcloud beta monitoring channels create/update/delete`, `gcloud functions call`, `firebase deploy`, or any command that triggers/fires/invokes/mutates without separate authorization.

---

## 6. Limitations

- **Alert opening and email delivery were not tested.** No policy was test-fired; no synthetic matching log/event/document was created. Confidence in the filters comes entirely from read-only verification of repository source tokens, live payload shape, and (where available) pre-existing natural log entries — not from an observed firing.
- **A5 should be re-reviewed** if the `resolveShiftCloseAlert` service adds more `unexpected error` log lines — the current filter's safety depends on that service having exactly one source of that phrase today.
- **Firestore Data Access historical-absence claims may not be fully provable** if Data Access audit logs are not enabled on this project — the "no direct data-plane write" conclusion in the Scope 2 verification relies partly on the Scope 1 operator's attestation plus the available Admin Activity and runtime logs, which were clean.
- The repository's rolling report previously stated no monitoring policy existed for Packet 5. This runbook and the accompanying tracker updates reconcile that statement to the current live state — G3 monitoring resources now exist and were independently verified.

---

## 7. Cost / free-trial note

- Expected G3 monitoring cost at current (near-zero) traffic is **negligible**: USD 0.00/month while Cloud Monitoring alerting remains unbilled, then an estimated USD 1.05–1.50/month (≈THB 39–49) once alerting billing begins (no sooner than 2026-09-01).
- **Free-trial credit expiry is estimated around 2026-08-27** (≈THB 9,751.22 remaining as of 2026-07-20, per owner-provided Billing Console evidence) — this is a **separate owner decision**, not resolved by this docs closure.
- **Runtime continuity of the entire Packet 5 pipeline** (all seven live functions, not just monitoring) may depend on a paid-account upgrade before trial expiry. This is a distinct, higher-stakes decision than the G3 monitoring footprint and should be tracked separately (see trackers, §Next Action).

---

## 8. Prohibited response actions

Without separate Gemini/Owner authorization, alert responders must **not**:

- manually edit `shiftCloseCases`, `shiftCloseAlerts`, `shiftCloseAuditEvents`, `shiftCloseAdjudicationCommands`, or `shifts` documents;
- create synthetic writes, events, or log entries to test or "confirm" an alert;
- perform ad-hoc recapture of shift-close evidence;
- deploy or redeploy any function, rule, or index;
- disable an alert policy, notification channel, or event trigger;
- test-fire an alert policy or otherwise induce a matching condition.

All of the above require explicit, separately authorized instructions before being performed.
