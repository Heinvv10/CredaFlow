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

## Candidate 3 superseded by actual upstream integration

Candidateb637a03eabd1dbd2362fba10cd48d7cafb442274 completed ci:quality exit0:1506unitfiles/19568tests PASS,335files/2940tests skipped,14actual face-model tests PASS and production build PASS. Its332-suite realDB gate remained running when actual upstream166 landed. Root authorized graceful supersession; MQ verified the exact own Vitest PID561198/cwd before SIGTERM. Integration exited143, automatic owned credaflow-ci-552127 container+volume teardown confirmed. Partial logs preserved; no integration PASS claimed.

Actual origin/maina740801a68ccdb4117b3d7b7ddd357f2f98a1b9a was fetched and reconciled by A mergeee15dc9903819a1c2b083063429d3ace863aaae0 (parentsb637+a740). B independently APPROVED exact combined source after6suites/26tests PASS; root source review no blocker. MQ fast-forwarded to exact reviewed merge, no own conflict resolution. Upstream Dialog/mobile layout retained, duplicate native-details menu removed, financial role/copy fixes preserved; G20 warning uses unchanged wording in proper DialogDescription. Root docs57437a79/30a5bc39/1fcd210f integrated serially before candidate4 freeze. All final full gates/image/browser remain mandatory on new source.

Private immutable acceptance image will use repository-supported always-pass synthetic Turnstile TESTsitekey/TESTsecret, explicitly root-authorized for owned disposable environment. This simulates anti-bot verification; it establishes no real Cloudflare defence. External providers remain disabled/internal-network isolated; local SMTP sink never relays. Private delivered-message extraction reads actual MIME sink files only, not database tokens.

## Candidate 4 image failure and reviewed G18-R correction

Candidate31339e0cc15478538ce6085fa808374cb2d08bf9 completed both mandatory gates: ci:quality exit0 (1506unitfiles/19569tests,335files/2940tests skipped;14actual face-model tests;productionbuild) and ci:integration exit0 (330files/2917tests passed,2files/2tests skipped,671.98s). Skips are actual VLM extraction corpus accuracy and statement-reader corpus accuracy, neither measured; two Docker opt-in suites also remain excluded. Owned credaflow-ci-1023629 container+volumes removed. Manual pinned NCA fingerprint command passed;5PDF samples/23rasterpages and extracted text match preserved baseline. F15 legal limitation unchanged.

Pristine Docker build attempt1 failed at SFace fullbody acquisition: steady public official-source transfer then `terminated`, builder9d4c4e427716 exit1,OOMfalse,14:05:26–14:17:10UTC. Full gate passes do not imply image/browser acceptance. Original logs, exit and network snapshots preserved privately. Same pinned URL HEAD returned200/38696353bytes; exact tail and1MiB requests returned valid206 ranges in46ms/91ms. No host-model overlay, pin change or Dockerfile workaround used.

A submission0ff96bb15950b951403b76a1d5105cfb157d694f,base31339e0c, independently APPROVED by B (13focused protocol tests rerun PASS) and root source review. A exact frozen ci:quick PASS; fresh empty-directory official model/license download and cached rerun PASS with original SFace SHA. MQ serially integrated668192a1 plus authorized root evidence/spec docs without conflicts. Downloader validates bounded response ranges/lengths/stable total, preserves initial full-response compatibility, verifies unchanged final SHA before atomic rename, and cleans partial files. All official URLs,pins,runtime thresholds and Dockerfile unchanged. No schema/DDL.

Candidate5 requires fresh uninterrupted full quality/integration and pristine image after final main-drift check. Prior candidate4 successes/imagefailure remain immutable, not reused as final-source acceptance. Browser drivers independently reviewed, still unrun. F15 legal branch remains unmerged. Portable immutable image export and final synthetic backup/restore will be prepared locally only after accepted browser evidence; no registry/cloud/public deployment authorized.


## Candidate 5 supersession and bounded transport retry

Reviewed clean merge3e667498 includes actual upstream163/main5711f533, additive Statement AI migration (default disabled, VLM unset). Its full ci:quality completed exit0:1516unitfiles/19657tests,338files/2953tests skipped,14actual face-model tests and production build PASS. Automatic integration startup was stopped after quality completion because the image transport correction superseded this source; exact owned process descendants were terminated and credaflow-ci-3530765 container/volumes removed. Partial integration is NOT PASS. No local NavBar leak reproduced.

Pristine image attempt2 failed at SFace transport after16MiB validated ranges: builder7b529a952e15 exit1,OOMfalse,14:33:46–14:40:05UTC. No runnable image or browser acceptance resulted; original logs/source/archive preserved. A correction2173ad85fef50447732b44ce683ad67b4b50876e independently APPROVED by B with18tests rerun PASS and root source review; exact frozen ci:quick PASS. It bounds each transport attempt to60seconds, retries transport/body exceptions three times at the same offset, and preserves immediate protocol/length/hash refusal, atomic publication and cleanup. Actual lightweight Docker official pinned acquisitions passed; this is not a full application image claim. MQ integrated c973ed80 and root evidence docs serially without conflicts.

Fresh origin/main remains5711f533; unrelated failed PR167 remains untouched/unmerged. Next frozen candidate requires exact-source full quality and integration, pristine image and real browser acceptance. Root authorizes image build CPUs0–3 concurrently with host quality CPUs4–7; host full suites remain serialized and integration starts only through a separate explicit phase. PR168 stays unqueued/unmerged pending required gates and independent acceptance. F15 code remains separate and legally gated.


## Candidate 6 exact gates, private acceptance and operator correction

Frozen aeacfc065b9b8234261c2158dd98271938671ad7 full quality PASS exit0 (1516files/19662tests,338files/2953tests skipped;14actual model tests; production build). Full integration PASS exit0 (333files/2930tests,2accuracyfiles/2tests skipped;335actual selected suites;614.08s), owned credaflow-ci-3847962 removed with volumes. Pristine image sha256:9ab61b563f05b99071a0e96a32f55a4e63966c241d986eb52079d30e4b2f83cb built successfully; unchanged official model/license hashes and native runtime verified with network none. Both synthetic runtimes report the baked exact source.

Private ingress uses loopback-only HTTP proxies to fixed owned internal app IPs, strict localhost/127/operator.localhost host allowlist and overwritten forwarded host/proto. Docker internal networking suppresses published ports; outbound isolation remains. Canonical base localhost:44213 and charges localhost:46203; NEXTAUTH_URL must remain configured for actual delivered recovery/invite origins. Removing it briefly fixed host redirects but produced unsupported email fallback localhost:3300; that configuration was corrected, failed evidence preserved. No production/config change inferred. Fixture asset/business credentials differed from snapshot shared password and were repaired via actual public forgot/reset API and actual local SMTP-delivered OTP, audited; no raw credential/database rewrite.

Actual F02 browser9cases passed. F10 browser9states passed including automatic UI-origin preview refresh/current-period totals after go-live/VAT/mapping changes, no navigation reload, actual close and CSV download. Independent Python CSV/Decimal reconciliation:139rows,407510112debit and credit cents equal actual closed preview. Portal evidence A4070d409 independently reviewed by B, scoped exclusively to candidate6. Other financial/staff/operator/recovery acceptance remains separately recorded; no full release acceptance claim. MIME extraction was corrected to read actual HTML anchor href rather than plaintext trailing punctuation; same delivered staff token then matched stored hash, no token invention/reissuance.

G06-U operator origin defect reproduced on candidate6: mandatory enrollment redirect changes operator host when NEXTAUTH_URL is configured. B30b2c7f8 independently APPROVED by A with36proxytests, exact frozen ci:quick PASS, root source review; MQ integrated c2a3f0ae plus reviewed A evidence9e9281e5 without conflicts. Next candidate must pass complete exact-source gates, pristine image and operator/new-candidate acceptance; predecessor passes never inherited. F15 remains separate, unmerged and legally gated.


Final pre-freeze main fetch discovered actual PR167 landing685c86e951c0591324446af148d30d41ddc33652. Root and A independently reviewed its exact four-file delta; A reran2suites/7tests PASS. Actual hosted quality/integration on head2970f904 succeeded. Additions only explicit demo-simulator manual-cron scheduling and real hydrated NavBar root cleanup, no schema/provider/production behavior activation. Clean reviewed merge-tree e0a5e75d05c30adc783b8dd62760284fe20ac65c reproduced and merged without conflicts; operator correction retained. Source is being revalidated before next freeze. Other sessions/queues preserved.


## Candidate 8: operator client callback correction

Candidate7 66c183c1 completed exact full quality, integration and pristine image checks; required hosted checks also passed. Financial, portal, staff, recovery and token evidence remains scoped to that source. Operator acceptance found a second real callback defect: NextAuth sign-out returned the configured staff origin after operator enrollment/sign-out. Consequently candidate7 is not accepted for merge. No release artifact or production deployment was approved.

A ecf84394c6abf7b8b25c2ed1c3f2224426208eae independently APPROVED by B (three suites/40 tests rerun PASS), root source review, and exact frozen ci:quick PASS. MQ serially integrated it as10d19e42, followed by independently reviewed A final66 evidence and root scoped evidence/specification records. Shared awaited redirect:false sign-out now navigates to the fixed same-host operator login; global authentication policy, CSRF and database schema are unchanged. Fresh main remains685c86e951c0591324446af148d30d41ddc33652.

Candidate8 requires fresh exact-source full quality/integration, pristine image and affected operator/browser acceptance. Historical passes are not inherited. Image build CPUs0–3 may run alongside serialized host quality then integration CPUs4–7. PR168 remains unqueued/unmerged. F15 remains separate and legally gated; its legal-only canonical model-list test failure does not establish a core regression.


## Candidate8 accepted core merge

Final exact63a quality, integration, required hosted checks, pristine image, browser acceptance, PDF preservation and independently reviewed portable artifact/restore proof all passed within their stated synthetic scope. Root gave final queue approval; MQ admitted only PR168 through existingmq. It merged at2026-10-17T16:09:55Z as9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a, exactcandidateancestor and identicalGit tree. Queue empty afterward. Final evidence is a separate docs follow-up; artifact remains baked63a. See FINAL-RELEASE.md. F15 remains unmerged/legal gated; no production/public demo deployment authorized or performed.

## Demo-approved declaration integration

The user explicitly approved resuming F15 for synthetic demo data. This supersedes the earlier pre-merge hold for this demo scope only; it is not named-lender legal sign-off or authority to deploy production or replace a public demo. MQ merged actual main37c85a18 into the independently reviewed proposal, preserving both applied declaration migrations. Frozen combined source70ab5bdebb8fa1655c7caf41dc069bc618623179 passed quick, full quality (1,522 files/19,688 tests,14 actual face-model tests and build), full integration (334 files/2,933 tests,2 explicit accuracy skips;336 selected), fresh private image and independently reviewed browser/PDF/three paired restore acceptance.

Required hosted integration passed; a later-starting skipped draft quality check shadowed a real quality pass under the queue's unchanged latest-check rule. MQ reran only quality, obtaining the newest required SUCCESS without changing source or rerunning integration. Following root approval and A's independent sealed1495-entry artifact review, existingmq merged PR171 at2026-10-17T20:17:11Z as0acd1bdf152c790b46ce4f1d0ecd7b820b1836e9. Fresh main's tree exactly matched tested70ab, with prior main37c85 and proposal64a1 preserved as ancestors. The queue was empty afterward.

The immutable local package remains baked70ab/image02b900ad, distinct from the merge commit and later status documentation. All prior63/64 packages and runtimes remain intact. The initial accounting fork's archive-layout error was corrected in the owned upload mount; a fresh paired restore verified all443 archive-entry hashes and347 referenced document files. The incomplete zero-file proof was preserved outside the sealed package. See FINAL-RELEASE.md for artifact hashes, accepted boundaries and the remaining real-lender configuration/legal requirements. No deployment occurred.
