# Mutation evidence

Each guard was broken on purpose and the named suite had to go red; the
mutation was then reverted and the suite re-run green. Code mutations were
applied to the source file and reverted with `git checkout`; SQL mutations
replaced the live trigger function on the disposable PG16 database
(`CREATE OR REPLACE` from `pg_get_functiondef`) and restored it the same way.
Scripts: `/tmp/claude-1003/lot-mut/{run,sql}.sh` (session scratch, not committed).

Unit = `lib/asset-finance/documents/templates/templates.test.ts`.
PG = `lib/asset-finance/documents/templates/templates.integration.test.ts` (RUN_ASSET_TEMPLATES_IT=1).

| # | Mutation | Suite | Result |
|---|---|---|---|
| m1 | ISA 7.6 override ignored (`lender(insurance(), …)` → `insurance()`) | Unit | killed, 1 failed |
| m2 | Money check disabled in the validator | Unit | killed, 3 failed |
| m3 | First attempt replaced cession text only | Unit | **survived** → test added: CPA saving prints after a 7.11 override |
| m3b | Lender override applied after the CPA appendix (appendix lost) | Unit | killed, 2 failed |
| m4 | Unknown/foreign tokens accepted | Unit | killed, 1 failed |
| m5 | Synthetic demo watermark not drawn | Unit | killed, 1 failed |
| m6 | Issuance ignores approval basis vs demo flag | PG | killed, 3 failed |
| m7 | E-sign re-render uses current lender identity | PG | killed, 1 failed |
| m8 | Stale approval (old content hash) accepted | PG | killed, 1 failed |
| m9 | Superseded input snapshots kept on disk | PG | **survived** → assertions added for the input file and null path |
| m9 (rerun) | same | PG | killed, 1 failed |
| s1 | SQL: issuance from any version of the template (current/ACTIVE check removed) | PG | killed, 1 failed |
| s2 | SQL: deal signer without issuance accepted | PG | killed, 1 failed |
| s3 | SQL: author approves own version | PG | killed, 2 failed |
| s4 | SQL: approval basis vs `isDemoLender` unchecked | PG | killed, 2 failed |
| s5 | SQL: version content mutable | PG | killed, 1 failed |
| s6 | SQL: wrong variant for the deal accepted | PG | **survived** (test tripped an earlier check) → test now matches every other field |
| s6 (rerun) | same | PG | killed, 1 failed |
| m10 | Issued mark always NONE (demo approval loses its watermark) | the two rewritten NCA unit suites | killed, 2 failed |

The two NCA unit suites (`legal-wording-flag-nca-*.test.ts`) were rewritten for
the new contract: the template mark, not the legacy flag, reaches the renderer,
and a missing template renders and writes nothing.
