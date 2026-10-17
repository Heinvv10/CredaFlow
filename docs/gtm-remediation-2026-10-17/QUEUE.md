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
| 1 | F01/F04/F05 | `cb35643d5442a7532a0e169c98a05e8db4ce456e` (base `3a0a17e3`) | B APPROVE: independently re-ran 6 suites/53 tests; registry subject/role/tenant inspection; coordinator admission authorized | `a679a71c` | branch quick passed; MQ affected regressions passing, exact six-suite verification running; combined full gates/browser pending | integrated, not accepted |

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
