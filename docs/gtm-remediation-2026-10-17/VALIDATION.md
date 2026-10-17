# Candidate validation iterations

## Candidate e1d5cff947488c2d97c7deb47add507b52112a4d

All reviewed F01-F14 software submissions integrated; F15 explicitly excluded in separate unmerged legal-review branch. origin/main re-fetched at3a0a17e3 with no new delta. Full quality ran under taskset0-3, Node22, availableParallelism4; no tests omitted.

Result: ci:quality exit1 in unit phase.1505files/19557tests passed,1file/3tests failed,333files/2932tests skipped. Exact failed file app/(portal)/portal/loans/page.locale.test.tsx: af/zu/xh expected translated outstanding metric prefixes but F12 had replaced them with English Outstanding principal. This is a genuine locale regression, not a timing failure. Integration/image/browser did not start; MQ stopped the queue. Failed log retained privately at /tmp/cf-gtm-rc-20261017-mq-hMJamG/evidence/candidate-ci-quality.log and explicit exit file.

Correction assigned A in already-owned af/zu/xh portal-loans.ts: precise principal labels in machine-draft locale, preserving locale regression tests and language-review gates. Root independent review and new committed source/full gate run required. No claim that the candidate passed full quality or browser acceptance.

## Reviewed correction243b95ecd2bedd0330d97a1ecc35a86b169b39ea

Root independently reviewed exact patch: six locale catalogs restore precise principal terms consistently for list/detail/statement; locale test strengthens exact terms for all four languages rather than accepting English in non-English output. MACHINE DRAFT notices, native-review records and language serving gates unchanged. This review approves software correction, not native translation quality.

Root independently ran Node22 Vitest5suites with maxWorkers2: portal loans page.locale, catalog, loan detail, statement, mobile sidebar. Result5files/215testsPASS, exit0,3.82seconds. A also reproduced exact3locale failures first and changed-file ESLint passed. MQ authorized serial integration then new full candidate/gates; old failed logs preserved.

## Candidate527291a79909b71a17e62aa225cb81fe7791fcde

Corrected full units passed uninterrupted:1506files/19560testsPASS,333files/2932tests skipped,219.18seconds. Quality reached pinned public model acquisition (YuNet complete/SFace pending), not full-quality exit. Newly reviewed recovery correction a6600c9d makes this source predecessor obsolete. Root authorized graceful stop of owned predecessor gate, retention of its partial evidence, copying independently hash-verified public model/license cache only, and a new exact final source full-quality/integration invocation including14actual model tests/build. This is not a full-quality pass or a waiver of any check. No private audit runtime/data reused.

G06-R source a6600c9d passed B independent review and rerun4unit63tests, A tsc/lint and2realDBsuites8cases; root source reviewed atomicity/guarded consumption/actor truth/no-secrets/preserved gates, no blocker. MQ authorized serial integration before final candidate source/gates/image.

## Candidate b637a03eabd1dbd2362fba10cd48d7cafb442274

MQ reported uninterrupted ci:quality exit0: app/demo typechecks, lint, documented paths/mirrors/date/timezone gates,1506unit files/19568testsPASS,335files/2940tests skipped (including8new realDB recovery cases reserved for integration),14actual pinned face-model casesPASS in3.57seconds, and production buildPASS. Owned disposable ci:integration is running; no result asserted yet. This remains predecessor evidence because actual main gained separately queued PR166 during validation. Fresh combined-source full gates and pristine immutable image/browser evidence remain required.

## Final core candidate31339e0cc15478538ce6085fa808374cb2d08bf9

MQ froze the independently reviewed reconciliation plus source/provenance documentation, preserving actual maina740801a ancestry. Uninterrupted ci:quality exit0:1506unit files/19569testsPASS,335files/2940tests skipped,242.30seconds;14actual pinned face-model testsPASS; production buildPASS; app/demo types/lint/docs/mirror/date/timezone gatesPASS. Statement and VLM accuracy are not implied by those face-model checks.

Uninterrupted owned-PostgreSQL ci:integration exit0:332selected suites,330filesPASS/2filesSKIP;2917testsPASS/2testsSKIP,671.98seconds,0baseline failures. The two skipped cases are lib/ocr/accuracy/accuracy.integration.test.ts (RUN_VLM_ACCURACY) and lib/statement-analysis/accuracy/accuracy.integration.test.ts (RUN_STATEMENT_ACCURACY); neither corpus accuracy gate was measured or waived. Two Docker opt-ins are also explicitly excluded from that gate; the independent pristine-image build is a separate artifact check. Owned credaflow-ci-1023629 database/container/volumes removed after completion. Selection inventory is not fabricated per-file output: reporter emitted aggregate completion only.

NCA fingerprint script and five executed/unsigned sample renders exit0 on the same core source. All five extracted texts and23page72dpi raster renders byte-identical to preserved synthetic baseline; binary PDF hashes may differ from metadata timestamps, no fingerprints repinned. F15 blank declarations are unchanged on core and remain the separate legal proposal.

Pristine git-archive Docker build is in progress, with source and build inputs captured outside the frozen worktree. Original official SFace download is progressing slowly by measured RX; no host-model overlay or pin waiver. No immutable image/runtime/browser acceptance claimed until completion.

Independent A source review approved post-freeze tracker33622b52 and gate-map09956bbc, checking31actual test paths and scope boundaries; permissive no-context RLS behavior remains distinct from strict-mode tests. B independently reviewed root browser drivers and caught an initial operator-refusal assertion that also accepted a granted view. Corrected pre-execution to require explicit no-active-grant refusal and no borrower table/Clients heading; B spot-reviewed approval. Driver preflight is not browser acceptance.

### Candidate31339 pristine-image attempt1 failed

Actual Step34 SFace full-body transfer terminated; Dockerexit1 after14:05:26–14:17:10UTC, OOMKilled=false. No image or runtime accepted. Source quality/integration passes above remain exact predecessor evidence. MQ retained immutable attempt logs/exit/transfer measurements and official HEAD/tail/1MiB range diagnostics. A implementing G18-R under682ea42c ownership/specification, B independent review follows; no changes to URL/pins/models/runtime thresholds/Dockerfile allowed. New reviewed source requires a new freeze and full gates/image. No old-image retries, host-cache overlay or fingerprint waiver.

## Candidate5 pristine image attempt: second acquisition failure

Exact source3e6674986e5fd782a6c24dce9b3a22354bdd3088 preserved currentmain5711f533. Adopted pristine build session50526/builder7b529a952e15 failed exit1, OOMKilledfalse,14:33:46–14:40:05UTC. Actual bounded range acquisition progressed to16MiB validated partial before a response body terminated; helper cleanup ran. No image/runtime/browser acceptance exists. Do not confuse root's pending-verification adoption of the ongoing build with a successful artifact. MQ retains original logs/exit/metrics.

A owns a second minimal G18-R correction on download helper/test/review note only: bounded per-chunk timeout and bounded transient transport/body retries at the same offset, with strict range/length/stable-total checks, official URLs/pins, final digest and atomic publication preserved. B independent review required. Exact3e667 hostquality already running will finish uninterrupted; avoid knowingly superseded fullintegration if correction is pending by that boundary. Ultimate reviewed source requires its own fullquality/integration/image/browser evidence. PR168 exists at3e667, unqueued/unmerged with required hosted checks only.
