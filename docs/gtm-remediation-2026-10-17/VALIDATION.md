# Candidate validation iterations

## Candidate e1d5cff947488c2d97c7deb47add507b52112a4d

All reviewed F01-F14 software submissions integrated; F15 explicitly excluded in separate unmerged legal-review branch. origin/main re-fetched at3a0a17e3 with no new delta. Full quality ran under taskset0-3, Node22, availableParallelism4; no tests omitted.

Result: ci:quality exit1 in unit phase.1505files/19557tests passed,1file/3tests failed,333files/2932tests skipped. Exact failed file app/(portal)/portal/loans/page.locale.test.tsx: af/zu/xh expected translated outstanding metric prefixes but F12 had replaced them with English Outstanding principal. This is a genuine locale regression, not a timing failure. Integration/image/browser did not start; MQ stopped the queue. Failed log retained privately at /tmp/cf-gtm-rc-20261017-mq-hMJamG/evidence/candidate-ci-quality.log and explicit exit file.

Correction assigned A in already-owned af/zu/xh portal-loans.ts: precise principal labels in machine-draft locale, preserving locale regression tests and language-review gates. Root independent review and new committed source/full gate run required. No claim that the candidate passed full quality or browser acceptance.
