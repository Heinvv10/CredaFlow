# bank-sync — bank-statement import & reconciliation

Reconciles incoming bank credits against active loans and turns confirmed
matches into `Payment` rows through the existing balance-recompute seam. It
never touches a bank session and never authorizes or releases money: it reads
a statement file a staff member uploaded and proposes matches for a human to
confirm. The CSV layout parsed today is ABSA's statement export.

The module's rules (money in cents, explicit `tenantId` scoping, the one money
path, auto-apply off by default) are in `lib/bank-sync/.claude.md`.

## Pipeline

```
Staff upload  app/(dashboard)/payments/bank-reconciliation/actions.ts
        │  bytes + actor
        ▼
lib/bank-sync/import.ts     importStatement(): the one pipeline, shared by every source
        │
        ├── parse.ts        parseStatementCsv: raw text → ParsedStatementLine[] (fail-loud on Date/Amount)
        ├── candidates.ts   active/defaulted loans → CandidateLoan[]
        ├── reconcile.ts    tiered matcher: EXACT / HEURISTIC / WEAK / NONE (exactly one candidate or NONE)
        ├── ingest.ts       persists BankStatementImport + BankTransaction rows, deduped by dedup.ts
        └── audit           every import, confirm and ignore runs through lib/audit.ts
        ▼
Review queue  → staff confirm → apply.ts creates the Payment and recomputes the loan
             → staff ignore  → ignoreBankTransaction() records the reason
```

Auto-apply of high-confidence matches is gated by
`TenantConfig.absaAutoApplyHighConfidence` (off by default). Even when on, a
guard failure leaves the transaction `PROPOSED` for review.

## Adding a statement source

Call `importStatement()` with the raw bytes and the acting user; never
re-implement parsing, matching or persistence. A new bank's CSV layout is a
new parser behind the same `ParsedStatementLine` shape.

## Tests

`*.test.ts` beside each file; parser fixtures in `__fixtures__/` are invented
statements, not exports of a real account.
