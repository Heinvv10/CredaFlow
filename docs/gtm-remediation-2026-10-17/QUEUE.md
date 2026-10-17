# GTM remediation integration queue

MQ is the sole writer of `fix/gtm-integration-20261017` in `/home/hein/Workspace/CredaFlow-gtm-mq`.
Initial freshly fetched base: `3a0a17e38b393d0c0707ed24e615be2b016f604e`.
Audit base: `5cb9279bc17d3c306e49c06c75b27660894eba73`.

A Wave A independently reviewed and serially integrated. No release gate has passed on the combined candidate.
No main merge, public-demo replacement, provider activation or production deployment has been performed.

## Admission and serialization

Each submission requires finding IDs, reproduced failure, base/submitted SHAs, exact changed files, actual test results, independent reviewer verdict, browser instructions/evidence, migration implications and remaining risks. MQ integrates one reviewed submission at a time. A substantive conflict or regression stops the queue and returns the affected paths to their owner. Never guess at conflict resolution or approve MQ's own changes.

| Order | Findings | Submitted SHA | Reviewer/verdict | Integrated SHA | Candidate checks | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | F01/F04/F05 | `cb35643d5442a7532a0e169c98a05e8db4ce456e` (base `3a0a17e3`) | B APPROVE: independently re-ran 6 suites/53 tests; registry subject/role/tenant inspection; coordinator admission authorized | `a679a71c` | branch quick passed; MQ exact 6 suites/53 tests PASS exit0; combined full gates/browser pending | integrated, not accepted |
| 2 | F02/F03/F10 | `aea9f3b4` then `9891a0ef` (base `3a0a17e3`) | A APPROVE exact final SHA; independent 6 suites/28 tests, B quick PASS | `3a337585` then `f7c72d67` | combined core 13 files/83 tests and ci:quick PASS | integrated, not accepted |
| 3 | F06/F07/F12 | `314a9321` then `34040560` | B APPROVE independent 4 files/34 tests; root payment-label blocker resolved | `0803b838` then `87516c0f` | MQ 4 files/34 affected portal tests PASS; final full gates/browser pending | integrated, not accepted |
| 4 | F09/F11/F13/F14 | `81d92ef2` | A APPROVE exact SHA; independent 11 files/55 tests; final quick PASS; root admission | `ab63b35d` | MQ changed 11 files/55 tests PASS; full gates/browser pending | integrated, not accepted |
| 5 | F08 | `9f2ba03e` | B APPROVE source +23 tests; A quick PASS and239 targeted; root admission | `1dd25343` | final full gates starting; browser pending | integrated, not accepted |

## Resource and runtime ownership

- All gate commands prepend `/home/hein/.nvm/versions/node/v22.23.1/bin` to PATH; shell default Node 20 is below the repository's supported engine.
- Dependencies installed locally with `npm ci --legacy-peer-deps`; initial install passed. Initial audit reported 5 moderate and 5 high dependency vulnerabilities; no unsolicited dependency mutation performed.
- Heavy full suites/builds require the coordinator's resource lock. Do not run candidate dev/start concurrently with integration suites that start Next in this worktree.
- Dedicated candidate DB name prefix: `cf-gtm-rc-20261017-mq-`; allocate a unique suffix and random loopback port using `scripts/it-db.sh`. Run ownership check before migrate. Teardown only the exact owned name with `docker rm -fv`.
- Candidate uploads/evidence/secret env files live under a unique private `/tmp/cf-gtm-rc-20261017-mq-*` directory. No external credential values enter logs or tracked files.
- Candidate HTTP binds only loopback on a checked free ephemeral port. Use separate Puppeteer browser contexts per role; installed `/usr/bin/google-chrome` is available.
- Existing audit/demo/acceptance containers belong to other sessions and must remain untouched.

## Candidate validation order

1. Review and serial integration, then affected targeted tests and `npm run ci:quick`.
2. Stop any Next runtime in this worktree. With resource lock run one uninterrupted `npm run ci:quality`, retaining exit status and full log. This includes full unit tests, face models and production build.
3. Run `npm run ci:integration` against its owned random-port disposable PostgreSQL; retain exact pass/skip/fail counts and any explicit exclusions. It performs its own teardown.
4. Build an immutable Docker image from the exact committed candidate with `GIT_SHA` and `BUILD_TIME`; record content image ID, build logs, Dockerfile/package-lock hashes and migration list. Do not substitute a mounted current build for fresh-image acceptance.
5. Seed or restore synthetic-only data into a separate owned candidate DB, migrate, record trigger and CHECK catalogs, verify identity/demo safety, remove/disable external providers and scheduler. Never reuse the mutated original audit DB.
6. Run the immutable image privately and verify `/api/health` revision plus targeted staff/portal/browser scenarios at desktop and 390px, light/dark, required roles. Record screenshots, DOM/assertions, browser console/network failures and exact candidate/image/database identifiers.
7. Reconcile financial scope, receipt allocation and accounting exports; inspect PDF render/fingerprint and declaration binding without changing approved legal presentation or pins absent sign-off.
8. Independent review of candidate evidence and outstanding release gates. A green branch or HTTP 200 alone is insufficient acceptance.

## Release and rollback preparation

Before requesting a deployment target approval, record immutable candidate SHA/image ID, migration ordering and compatibility, synthetic acceptance evidence and explicit unverified provider/legal scope. There is currently no selected production hosting target.

For any eventual named target: retain its previous exact image/config and pre-migration database plus uploads backup; verify backup restore into an isolated DB first. Additive nullable migrations may precede code only when proven compatible; enforcement migrations and their compatible code ship together. A rollback that cannot safely run old code against the migrated schema restores the verified DB/uploads backup and matching prior image as a unit, with approved downtime/data-loss boundary. Never reverse shared DDL by hand or promote `latest`.

## Wave A second admission

B final submission `9891a0efb2f30726cbdc056c20b8a94d8824a8a0`, base `3a0a17e38b393d0c0707ed24e615be2b016f604e`, comprises `aea9f3b4` then `9891a0ef`. A independently APPROVED exact final SHA (6 suites/28 tests), conditional quick now confirmed PASS by B; root admitted. MQ cherry-picked serially without conflicts as `3a337585` then `f7c72d67`. Findings F02/F03/F10 integrated, not accepted. Combined Wave A 13 files / 83 targeted tests PASS (3.51s) and uninterrupted ci:quick PASS exit0 (Node22); full quality/database/image/browser deferred until experience/F08 integration. No schema or migration changes.

Coordinator approved final full quality invocation under `taskset -c 0-3` (host allowed CPUs 0-31), preserving every quality step/test while bounding workers. Record Node22 availableParallelism=4 in evidence. No heavy run yet; wait reviewed experience/F08 candidate.

Origin/main refreshed via git fetch after experience integration preparation: still exact `3a0a17e38b393d0c0707ed24e615be2b016f604e`, no upstream delta. Recheck before final source freeze.

Final source freeze preparation: origin/main freshly re-fetched after F08 integration, still exact initial base3a0a17e3; no upstream source/migration delta. B supplemental review recorddc02dfb7 integrated. All F01-F14 remediation code integrated; F15 legal proposal deliberately excluded and externally gated. Coordinator authorized uninterrupted ci:quality then ci:integration under four-CPU affinity, followed by fresh immutable image/private browser acceptance. Stop queue on any regression.

## Candidate 1 regression and reviewed correction

Frozen `e1d5cff947488c2d97c7deb47add507b52112a4d` full ci:quality stopped at real locale mismatch: 1505 files/19557 tests passed; app/(portal)/portal/loans/page.locale.test.tsx had 3 failures for af/zu/xh; 333 files/2932 tests skipped. Integration and image did not start. Original log/exit/archive retained privately without overwrite.

A correction `243b95ecd2bedd0330d97a1ecc35a86b169b39ea` adds precise native-language draft principal terms consistently across list/detail/statement and strengthens exact locale assertions. Coordinator independently APPROVED exact SHA with 5 suites/215 tests PASS; this is source review, not native-speaker/legal approval. Existing MACHINE DRAFT, language review/hash gates remain unchanged. MQ integrated the isolated correction without conflicts, re-fetched main (unchanged initial3a0a17e3), and prepares candidate2 full quality/integration under the same fourCPU affinity. New logs use candidate2-* so the failed first run remains immutable.

## Candidate 2 superseded and recovery admission

Candidate527291a79909b71a17e62aa225cb81fe7791fcde passed full unit phase uninterrupted (1506 files/19560 tests, 333 files/2932 tests skipped,219.18s) then remained pending public SFace acquisition. Coordinator explicitly authorized superseding it for reviewed G06-R; MQ verified and TERM-stopped only its owned model-fetch PID191887. Quality exit143/abort evidence retained; no full-quality, face-model, build or integration pass claimed. Its source archive is preserved privately.

Recovery submissiona6600c9d0bd5abb20c31b8367d8a4af5b0745b24 independently APPROVED by B with4unit suites/63tests rerun; root source review found no blocker; A provided8realDB fault/atomicity cases plus63unit passes. Root admitted; MQ serial integration557a05b9 without conflicts. No schema/DDL, provider or statutory wording change. B reviewer source record8b17dfda exists on separate legal branch; skipped wholesale cherry-pick because it also changes an absent B-F15 doc, and records verdict here instead.

Candidate3 preparation: origin/main freshly fetched, remains exact3a0a17e38b393d0c0707ed24e615be2b016f604e. Public weights/licenses copied from read-only audit cache only after every file matched current source-pinned SHA256; source NOTICE copied. No audit runtime/data reused. Actual final face model tests and every full quality/database step remain mandatory. New logs candidate3-*; prior logs immutable. F15 legal code remains excluded.
