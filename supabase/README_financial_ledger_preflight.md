# Financial Ledger preflight

These files are manual, read-only gates; they do not apply a migration:

1. Run `preflight_financial_ledger_18.sql` immediately before migration 18.
2. Apply migration 18 only after every required check passes.
3. Run `preflight_legacy_cutover_19.sql` immediately before migration 19.
4. Apply migration 19 only after its required checks pass. A non-zero existing
   carryover count is a stop: no `effective_date` may be inferred.

## Production-like DB versus clean environment

These are separate concerns. The current production-like database has already
been read-only verified to use UUID regional keys and to contain `alloc`,
`exec`, and `rate`; it can be evaluated for 18/19 with these preflight files.

A blank database cannot currently be reproduced from `schema.sql` plus the
historical migrations alone. `schema.sql` still describes varchar region keys
and `regions.code`, while the production-like database uses UUID region keys
and `regions.id`. The historical migration chain also does not establish the
`projects.alloc`, `projects.exec`, and `projects.rate` columns on its own.
This is repository technical debt, not a reason to reinterpret a successful
production-like preflight as failed. Do not rewrite historical migrations in
place; introduce a separately reviewed clean-environment compatibility path
when clean bootstrap becomes necessary.

## Legacy Baseline source interpretation

Read-only analysis of 3,895 current official projects found 121 rows with
`alloc = 0`, no `exec > alloc` rows, no NULL `rate` rows, and 3,774 rows where
`alloc > 0`. For all 3,774 comparable rows, stored `rate` matched
`exec / alloc * 100` within +/- 0.005 percentage points. Baseline therefore
interprets `projects.alloc` as current/adjusted allocation and `projects.exec`
as cumulative execution. It does not reconstruct historical transactions.
