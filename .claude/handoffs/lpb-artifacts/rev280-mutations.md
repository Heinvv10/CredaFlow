# PR 280 mutation results, head 50b007cc

Own clone; each mutation run against scoped unit suites, then a5b + decide-gate IT if unit stayed green. 50 killed, 32 survived of 82 planned.

| Result | Mutation | File |
|---|---|---|
| SURVIVED | repr: due today rewritten | `lib/product-engine/reprice.ts` |
| SURVIVED | repr: period starting ON effective date skipped | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: paid-in-advance PENDING row rewritten | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: non-PENDING row rewritten | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: tail run ignores first-row period start uses dueDate | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: principal-only grace lost | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: credit-life dropped from totalDue | `lib/product-engine/reprice.ts` |
| SURVIVED | repr: balloon min() removed | `lib/product-engine/reprice.ts` |
| KILLED(unit) | repr: interestDelta wrong sign | `lib/product-engine/reprice.ts` |
| KILLED(unit) | reprL: idempotence >= to > | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: updateMany not pinned to PENDING/unpaid | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: rule baseRate not moved | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: contractualTotalRepayable not moved | `lib/product-engine/reprice-loan.ts` |
| KILLED(unit) | reprL: totalRepayable not moved | `lib/product-engine/reprice-loan.ts` |
| KILLED(unit) | reprL: loan.interestRatePm not moved | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: unchanged check removed | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: not-ACTIVE guard removed | `lib/product-engine/reprice-loan.ts` |
| KILLED(unit) | reprL: lock removed | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprL: basis check removed | `lib/product-engine/reprice-loan.ts` |
| SURVIVED | reprB: value order desc | `lib/product-engine/reprice-batch.ts` |
| SURVIVED | reprB: failure does not stop the loan | `lib/product-engine/reprice-batch.ts` |
| SURVIVED | reprB: only APPROVED filter removed | `lib/product-engine/reprice-batch.ts` |
| SURVIVED | reprB: future values applied | `lib/product-engine/reprice-batch.ts` |
| KILLED(unit) | sched: flat balloon not on last row | `lib/product-engine/schedule.ts` |
| KILLED(unit) | sched: r=0 ignores balloon | `lib/product-engine/schedule.ts` |
| KILLED(unit) | sched: PV of balloon undiscounted | `lib/product-engine/schedule.ts` |
| KILLED(unit) | var: margin ignores reference | `lib/product-engine/variable-rate.ts` |
| KILLED(unit) | var: floor at 0 removed | `lib/product-engine/variable-rate.ts` |
| KILLED(unit) | var: referenceOn takes unapproved | `lib/product-engine/variable-rate.ts` |
| SURVIVED | var: referenceOn excludes the effective day | `lib/product-engine/variable-rate.ts` |
| SURVIVED | var: referenceOn takes oldest | `lib/product-engine/variable-rate.ts` |
| SURVIVED | resolve: margin off base, rule discount lost | `lib/product-engine/resolve.ts` |
| KILLED(unit) | terms: missing reference not refused | `lib/product-engine/approval-terms.ts` |
| SURVIVED | mc: verify skips DEACTIVATE refusal | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: verify skips UPDATE check | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: verify skips CREATE refusal | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: already-inactive not refused | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: baseRef constant, never stale | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: LOAN_ADMIN may approve | `lib/product-config/change-handler.ts` |
| KILLED(unit) | mc: provenance dropped from audit | `lib/product-config/change-handler.ts` |
| SURVIVED | mc: lockProduct no FOR UPDATE | `lib/product-config/product-change-rules.ts` |
| SURVIVED | mc: NCA type on edit allowed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: NCA type on create allowed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: versioned field not restored | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: versioned refusal removed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: type change on versioned product allowed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: stable code rename allowed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: asset-finance kind lock removed | `lib/product-config/product-change-rules.ts` |
| KILLED(unit) | mc: duplicate code on create allowed | `lib/product-config/product-change-rules.ts` |
| SURVIVED | rule: PART_TIME refused | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: employment status ignored | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: payroll number optional | `lib/product-types/rules.ts` |
| SURVIVED | rule: employer optional | `lib/product-types/rules.ts` |
| SURVIVED | rule: SME registration optional | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: SME turnover optional | `lib/product-types/rules.ts` |
| SURVIVED | rule: SME name optional | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: SME purpose ignored | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: group of one allowed | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: non-member borrower allowed | `lib/product-types/rules.ts` |
| SURVIVED | rule: arrears 1 day passes | `lib/product-types/rules.ts` |
| SURVIVED | rule: group arrears ignores status | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: group arrears only the borrower | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: revolving limit boundary | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: revolving ignores draw | `lib/product-types/rules.ts` |
| SURVIVED | rule: revolving across all products | `lib/product-types/rules.ts` |
| SURVIVED | rule: revolving counts closed loans | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: NCA refusal removed | `lib/product-types/rules.ts` |
| SURVIVED | rule: no-client refusal removed | `lib/product-types/rules.ts` |
| KILLED(unit) | rule: NCA early return gate broken (all types read) | `lib/product-types/rules.ts` |
| KILLED(unit) | checkoff: closed loans listed | `lib/product-types/check-off.ts` |
| KILLED(unit) | checkoff: other products listed | `lib/product-types/check-off.ts` |
| KILLED(unit) | checkoff: paid rows listed | `lib/product-types/check-off.ts` |
| KILLED(unit) | checkoff: formula guard removed | `lib/product-types/check-off.ts` |
| KILLED(unit) | facts: setter not input staff | `app/api/applications/[id]/product-facts/route.ts` |
| KILLED(unit) | facts: closed application writable | `app/api/applications/[id]/product-facts/route.ts` |
| KILLED(unit) | facts: foreign group accepted | `app/api/applications/[id]/product-facts/route.ts` |
| SURVIVED | facts: permission check removed | `app/api/applications/[id]/product-facts/route.ts` |
| SURVIVED | rates: POST permission removed | `app/api/products/lending-rates/route.ts` |
| KILLED(unit) | rates: POST NCA gate removed | `app/api/products/lending-rates/route.ts` |
| KILLED(unit) | rates: decide permission removed | `app/api/products/lending-rates/[id]/decide/route.ts` |
| SURVIVED | rates: decide other-basis allowed | `app/api/products/lending-rates/[id]/decide/route.ts` |
| SURVIVED | groups: PUT cross-tenant check removed | `app/api/products/groups/[id]/route.ts` |

BASE 0

## Round 2, head 03fd5dd1

TS mutations: scoped unit suites, then the 6 PR integration suites (47 tests). SQL mutations: function re-created in a migrated disposable DB, the integration suites run, then restored (verified).

| Result | Mutation | File |
|---|---|---|
| KILLED(unit) | reprice: common-law row not a stop | `lib/product-engine/reprice.ts` |
| KILLED(unit) | reprice: carried principal priced | `lib/product-engine/reprice.ts` |
| KILLED(unit) | reprice: carried interest dropped | `lib/product-engine/reprice.ts` |
| KILLED(unit) | history: from = effective date only (reaches back) | `lib/product-engine/rate-history.ts` |
| KILLED(unit) | history: first row not from startDate | `lib/product-engine/rate-history.ts` |
| KILLED(unit) | history: not monthly x12 | `lib/product-engine/rate-history.ts` |
| KILLED(unit) | replay: terms history not used (NON_NCA) | `lib/loan/charges-replay.ts` |
| KILLED(unit) | replay: terms history not used (NCA) | `lib/loan/charges-replay.ts` |
| KILLED(unit) | revolving: settled list includes nothing (counts COMPLETED) | `lib/product-types/rules.ts` |
| KILLED(unit) | revolving: DEFAULTED treated as settled | `lib/product-types/rules.ts` |
| KILLED(unit) | revolving: approved-unpaid ignored | `lib/product-types/rules.ts` |
| KILLED(unit) | revolving: own application counted | `lib/product-types/rules.ts` |
| KILLED(unit) | revolving: settling loans counted | `lib/product-types/rules.ts` |
| SURVIVED | revolving: only this product | `lib/product-types/rules.ts` |
| KILLED(unit) | group: DEFAULTED ignored | `lib/product-types/rules.ts` |
| KILLED(unit) | group: WRITTEN_OFF ignored | `lib/product-types/rules.ts` |
| KILLED(unit) | group editor: not recorded | `lib/product-types/groups.ts` |
| SURVIVED | group editor: closed apps too | `lib/product-types/groups.ts` |
| KILLED(unit) | decide: group editor may approve | `app/api/applications/[id]/decide/decide-application.ts` |
| KILLED(unit) | pricing: ADD rounding removed | `lib/product-engine/pricing.ts` |
| KILLED(unit) | schedule: fixed balloon validated as share | `lib/product-engine/schedule.ts` |
| KILLED(it) | guardLoanTerms: rate not tied | `prisma/migrations/20261106100100_product_types/migration.sql` |
| KILLED(it) | guardLoanTerms: structure not tied | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | guardLoanTerms: request not this loan's | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | hash: variableRate omitted | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | hash: balloonPct omitted | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | mandate guard: margin unchecked vs version | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | mandate guard: unapproved reference | `prisma/migrations/20261106100100_product_types/migration.sql` |
| SURVIVED | mandate guard: rule tolerance ignored (any rule rate) | `prisma/migrations/20261106100100_product_types/migration.sql` |

"revolving: only this product" was a no-op mutation (equivalent). Baseline after: green.

## Round 3, head 9be237cd

Correction to round 2: the SQL survivors for the hash, mandate-guard and cross-loan terms mutants were not valid. The harness changed functions in the shared DB, but the suites that reach those lines build a throwaway DB from the migration files. Round 3 mutated the migration file.

| Result | Mutation |
|---|---|
| KILLED(it) | hash: variableRate omitted |
| KILLED(it) | hash: balloonPct omitted |
| KILLED(it) | hash: variable after version (order) |
| KILLED(it) | mandate: version margin unchecked |
| KILLED(it) | mandate: unapproved reference |
| KILLED(it) | mandate: future reference |
| KILLED(it) | mandate: rule rate unchecked |
| SURVIVED | mandate: rate not reference+frozen margin |
| SURVIVED | mandate: no-rule rate may differ from base |
| SURVIVED | mandate: retired rule accepted |
| SURVIVED | mandate: NCA regime also widened |
| KILLED(it) | terms: request not this loan's |
| KILLED(it) | decision: account control skipped |
| KILLED(unit) | loan change: no client lock on revolving |
| KILLED(unit) | census: LOAN_PRODUCT dropped |
| KILLED(it) | terms: future value backs a repricing row |
| KILLED(it) | groups: closed applications too |
| KILLED(it) | decide route: account_controlled not answered 403 |

Baseline after: green.
