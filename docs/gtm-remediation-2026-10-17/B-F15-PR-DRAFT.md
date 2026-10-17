# Draft PR: Record explicit portal declarations and append bound acceptance evidence

Review source: `79c6e3270b53c059a8e0666c767c01c7e2f68353`, based on frozen core `3e6674986e5fd782a6c24dce9b3a22354bdd3088`. This review document is separate from that frozen source. Keep the proposal draft, outside the remediation merge queue. No legal approval or deployment authorization exists.

## Proposed PR body

Portal signing currently keeps five declaration checkboxes only in browser state. The server records a signature without retaining which individual statements the client accepted, and the original agreement's declaration boxes remain blank. This proposal captures the exact displayed statements and appends a bound acceptance certificate to the executed PDF when matching immutable evidence exists.

The portal request supplies an explicit version, declaration-set SHA-256 and all five IDs. A receipt is inserted transactionally with the signature and binds tenant, application, client, signer, method and signing time to the agreement, PASQ and signature digests. Composite foreign keys, CHECKs, a ceremony-specific unique key and an INSERT binding trigger validate receipts; UPDATE/DELETE are refused. Execution rejects inconsistent present evidence. Historic signatures without receipts and branch/paper signatures retain their existing behavior and receive no inferred certificate. Signing-audit JSON is supplementary, never the authoritative receipt.

The certificate quotes the existing portal wording exactly. It does not tick the printed boxes or equate “read and understood” with the printed PASQ “received” declaration. Original agreement bytes and existing fingerprint pins are unchanged. This is a legal presentation proposal, not approval of the resulting agreement.

Validation completed: fail-first missing-payload reproduction; 309 targeted unit tests, 10 existing pinned-PDF tests and the dedicated real-DB integrity test on the earlier proposal base; full quick gate on that base. After rebasing to the stated frozen source, registry/Prisma generation and four targeted suites/10 tests passed, with all five proposal patches unchanged by range-diff. Complete final-base quality, integration, build and browser acceptance remain **pending**. Earlier checks do not establish a final release pass.

Rendered samples include 3- and 60-instalment agreements. The appended certificate adds one page (candidate totals five and six pages). All nine existing executed pages are pixel-identical at72dpi; regression checks also preserve original page content streams and geometry. Sample PDFs, certificate images, extracted text, digest manifest and comparison evidence are retained in `evidence/f15-candidate/render/`.

Deploy only after named-lender legal approval and separate target authorization. Migration `20261017160000_agreement_declaration_evidence` and matching capture/renderer code ship together: pause signing/countersigning, preserve verified backups and artifacts, migrate, start the matching image, verify and resume. The final proposal chain currently contains113 migrations; identify the migration by name rather than a permanent ordinal. Before any new ceremony, an old-image rollback requires proving no new signatures/receipts were committed. After a new ceremony, an old renderer can hide the certificate: pause writes, retain evidence-aware rendering and every immutable receipt/document/signature, then fix forward. Never drop receipts, bypass immutability or restore an older backup over newer ceremonies.

## Legal review decisions required

1. Approve or reject the exact appended certificate as the representation of electronic declaration acceptance, including its attachment to the executed agreement while the original printed boxes remain blank.
2. Confirm the distinction between the first portal statement (“read and understood this Pre-Agreement Statement and Quotation”) and the printed PASQ-received statement. No equivalence or retrospective acceptance is inferred.
3. Review all five verbatim statements, version `portal-agreement-declarations-v1` and set digest `94948b549e9415944b73909f0dce298c5b304e8ed4f832de4e14787e5452cfd7`. Any wording revision requires a new version, matching evidence enforcement and fresh rendered review; never silently repin.
4. Approve the displayed signer/client/application identifiers, signing time, document/signature hashes and declaration-set hash as sufficient and appropriate evidence for the named lender. The certificate records assertions; it is not independent identity verification or a statutory compliance certification.
5. Approve treatment of historic/no-receipt and returned-paper ceremonies, retention of append-only receipts and the post-ceremony rollback boundary. No backfill or historical reinterpretation is proposed.
6. Sign off the short and continuation PDF samples and exact digest manifest for that lender before merge/promotion. Synthetic sample review does not substitute for each lender's approved identity/template review.

## Review package navigation

- `B-F15.md`: reproduction, scope, policy boundary, earlier tests, deployment ordering and rollback.
- `evidence/f15-candidate/render/SHA256.json`: rendered artifact manifest.
- `evidence/f15-candidate/render/original-page-raster-comparison.json`: all nine preserved original-page comparisons.
- `evidence/f15-candidate/render/agreement-{3,60}-{UNSIGNED,BEFORE,CANDIDATE}.pdf`: short and continuation comparison sets.
- `evidence/f15-candidate/render/certificate-{3,60}.png` and `agreement-3-CANDIDATE.txt`: visual/text review.
- `evidence/f15-candidate/`: owned-DB catalogs, migration logs and targeted evidence; dates/base scope remain explicit in `B-F15.md`.

No remote PR was opened by this preparation step. No merge, provider activation, real data change or deployment occurred. Final full gates and legal approval remain outstanding.
