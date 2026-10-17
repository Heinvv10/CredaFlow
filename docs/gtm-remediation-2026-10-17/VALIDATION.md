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
