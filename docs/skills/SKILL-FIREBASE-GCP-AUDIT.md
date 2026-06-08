# SKILL: Firebase / GCP Audit

Live Firebase environments require rigorous checks before and during deployments.

- **Live Firebase audit checklist:** Validate environment integrity before deploying.
- **Verification:** Always verify project, region, and named database (e.g. `pos-db`) explicitly via CLI output.
- **Functions allowlist:** Use explicit deploy targets (`--only functions:funcA,functions:funcB`).
- **No deploy/delete unless explicitly approved:** Do not mutate live infrastructure on your own initiative.
- **Captured command output required:** Real output from live queries or dry-runs must be logged in reports.
- **Live state must not be inferred:** Local config (`firebase.json`, `.env`) is not proof of live state; use CLI verification.
- **Production commands:** Final production `deploy` or `delete` commands require CEO/Tech Lead final approval.
