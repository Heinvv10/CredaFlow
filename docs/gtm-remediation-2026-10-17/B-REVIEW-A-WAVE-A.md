# Independent B review of A Wave A

Reviewed immutable submission `cb35643d5442a7532a0e169c98a05e8db4ce456e`, base `3a0a17e38b393d0c0707ed24e615be2b016f604e`.

Verdict: approve code changes for queue admission, conditional on the coordinator/MQ's integrated gates and browser acceptance. No substantive correction found.

- F01: both AVS presentation and route now use payout OR collection enablement; both false still refuses before a provider call. The CREDIT_OFFICER guard and tenant-scoped application query remain ahead of provider invocation. Consumer AVS continues to reject entity borrowers. The provider registry and persisted account-subject/fingerprint matching were not weakened; payouts can invoke the existing explicitly configured AVS provider without activating collections.
- F04: the application is read with its session tenant, then a linked deal redirects before consumer evidence checks. Both natural-person and entity shapes are covered. The destination independently requires staff access and its own tenant-scoped deal load and feature layout, so the redirect grants no extra permission. Stored term/decision presentation remains owned by that existing deal page.
- F05: both current and legacy collections tables require NCA regime before showing the statutory action. The current page already forwards full loan scalar properties, including ncaRegime. NON_NCA explanatory text replaces the notice action; direct backend refusal is unchanged. Existing NCA ordinary/asset and non-NCA lease render tests cover the changed boundary.

Inspected all changed source/tests and original downstream provider, subject, destination authorization and collection-loader boundaries. The six A Wave A test/source files remained byte-identical to the reviewed commit when re-running targeted tests in A's worktree; its unrelated Wave B edits were not touched. Targeted verification: `npx vitest run 'app/(dashboard)/applications/[id]/page.test.tsx' 'app/api/applications/[id]/avs-check/route.test.ts' components/collections/CollectionsTable.test.tsx components/collections/CollectionsTabs.test.tsx lib/avs.test.ts lib/payouts/avs.test.ts --maxWorkers=2` passed 6 files / 53 tests on Node22.23.1.

Remaining acceptance boundary: simulated all-four flag browser matrix, actual asset application/deal matching terms, direct non-NCA notice refusal, full combined candidate quality/integration and release browser evidence remain required; component and mocked route results do not prove those.
