# Total-loss closure fix, 2026-10-18

Independent reviewer reproduction: `671a7c329d2e928cbcf62e8d82809138b64dcfa9`. The original code left an honestly fully paid stolen lease RETURN/ELECTED and refused billing without inspection. The reproduction is retained as an intended-behaviour regression in `lib/asset-finance/blind-code-total-loss.integration.test.ts`.

The prepared fix distinguishes TOTAL_LOSS from a return, offers settlement directly,
keeps the asset unavailable, settles genuine maintenance balances and closes only
once all debt is paid. A LESSEE_SETTLED surplus needs an actual external refund's
exact amount, payment date, unique bank reference and retained staff-uploaded
original-deal proof. The staff form records evidence; it sends no bank payment.

Before the migration gate, unchanged-source real-PG red under TZ=UTC:
`/tmp/cf-lease-closure-red.log` (expected honest billing ok, received refused).
Read-only trigger/CHECK inventory: `/tmp/cf-lease-closure-catalog-{triggers,checks}.log`.
TypeScript, scoped ESLint and 201 focused unit/schema/registry tests passed during
preparation. Candidate migration execution and final real-PG green are pending
explicit §8 approval; no final acceptance claim is made here.

Prepared coverage: operating loss, lender-risk FML loss, lessee-settled FML with
real refund evidence, refusal without/mismatched/cross-lease/future refund proof,
actual cash unchanged by settlement, no fabricated inspection/usage, paid closure,
unpaid damages remaining open until receipt, and asset/refund guard mutations.
