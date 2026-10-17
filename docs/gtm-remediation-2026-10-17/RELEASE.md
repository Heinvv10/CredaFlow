# Private GTM release candidate preparation

Status: prepared environment, no application submissions integrated or accepted yet. No deploy target selected or authorized.

## Provenance and isolation

- Source starting point: `3a0a17e38b393d0c0707ed24e615be2b016f604e`.
- Candidate branch/worktree: `fix/gtm-integration-20261017`, `/home/hein/Workspace/CredaFlow-gtm-mq`.
- Runtime owner: MQ only. Private path `/tmp/cf-gtm-rc-20261017-mq-hMJamG` (0700).
- Database container: `cf-gtm-rc-20261017-mq-hMJamG`, owned via `scripts/it-db.sh` label. Database `credaflow_rc`, loopback port 50169. Before every migration source private `db.env` and run `bash scripts/it-db.sh check`.
- Internal Docker network: `cf-gtm-rc-20261017-mq-hMJamG-net`, alias `db` for this database. Final image runtime uses this network, keeping external provider destinations unreachable. Browser endpoint will be a unique loopback-published port.
- Data source: read-only synthetic snapshot `/home/hein/credaflow-demo-data/snapshots/20261016T084851Z/{db.dump,uploads.tar.gz}`. It was baked on application `a0179c6f`; the private restored copy was migrated successfully to current candidate base. The old application's image is not our release artifact.
- Uploads copied into private runtime directory: 443 files. Source snapshot and existing demos/audit runtime were untouched.
- Credentials copied to `synthetic-credentials.txt` inside private runtime directory, mode 0600. Never commit or print these values.

Provider safety preparation passed: nullable provider secrets/tokens/keys/SMTP/IMAP credentials removed from restored configuration; EmailConfig inactive; CommsSettings WhatsApp, bot and auto-reply off; IntegrationConfig BulkSMS, Netcash, TransUnion and Smile off. Final app environment will be an explicit synthetic allow-list, with no provider secrets or CRON_SECRET. Retain simulated provider labels where needed for authorized synthetic acceptance.

Evidence already retained privately: `evidence/initial-migrate.log`, `provider-safety.log`, `triggers-initial.txt`, `checks-initial.txt`, `backup-credaflow_rc.txt`, `backup-credaflow_restore_drill.txt`, `backup-upload-compare.txt`. These prove preparation only, not candidate application acceptance.

## Build and validation record to complete

| Item | Required exact evidence | Current result |
| --- | --- | --- |
| Final source | committed SHA and clean tracked tree | pending submissions |
| Independent review | reviewer, exact submitted SHA and resolved findings | pending |
| Quality | uninterrupted `npm run ci:quality`, exit status and retained log | pending |
| PostgreSQL integration | `npm run ci:integration`, counts/skips and exit | pending |
| Fresh immutable image | git-archive source context, build args/log, content image ID | pending |
| Runtime provenance | image ID, `/api/health` revision, migration list | pending |
| Browser acceptance | finding-specific assertions and screenshots on image | pending |
| Financial invariants | receipt allocation, book/report sums, CSV balancing | pending |
| PDF evidence | rendered comparison, fingerprints, immutable binding | pending |
| Backup/restore drill | private pg_dump + uploads archive, separate verified restore | baseline passed: 35 loans, 56 applications, 60 payments match; allocation invariant passes both DBs; all 443 upload files byte-identical. Repeat after final candidate mutations |
| External acceptance | provider/legal/configuration gates in TRACKER | not authorized by synthetic acceptance |

Use a `git archive` export of the exact final committed SHA as Docker context. Do not include private env files, runtime credentials, uploads or untracked helpers. Set exact GIT_SHA/BUILD_TIME/NEXT_PUBLIC_TENANT_SLUG build args and record resulting image ID. Run that ID directly rather than a mutable tag. Retain build provenance and candidate screenshots together. An image rebuilt from a later SHA needs its own acceptance.

## Rollback and teardown

Private acceptance rollback means stopping only the owned candidate app, restoring the owned database/uploads backup, and rerunning its exact immutable image. Verify a restore into another owned DB before claiming rollback readiness. Remove private app, then database via `scripts/it-db.sh down cf-gtm-rc-20261017-mq-hMJamG` (`docker rm -fv`), then its network, only after preserving evidence and coordinator approval to end acceptance.

No production rollback command can yet be final because hosting/target/backup locations are unspecified. Before any named target deployment, inventory its exact prior image/config, verify database+uploads backup restore, assess migration compatibility, and record recovery timing/data-loss boundaries. Enforcement migrations ship with compatible code; never manually reverse shared DDL. Production deployment, real provider activation and replacing an existing public demo still require explicit target authorization.

## Preparation independent review

Coordinator reviewed the private launcher and identified that a runtime GIT_SHA override could disguise image provenance. Resolved before any run: launcher now asserts the immutable image Config.Env baked-in GIT_SHA equals the requested candidate, omits a runtime GIT_SHA override, and separately verifies health revision. It also requires Docker network Internal=true, retains image-env evidence, and publishes only loopback. Fresh archive/build records and image ID remain required. Launcher bash syntax check passed; runtime execution pending built candidate.

## Operator acceptance fixture

Read `lib/operator/AGENTS.md`: the modern console is restricted to OPERATOR_APP_HOST, requires mandatory TOTP, operator-scoped roles with no tenant, and borrower access only through an audited support grant. The retired demo-sim SUPER_ADMIN bootstrap does not provision this console and its target guards were not bypassed. MQ created one fresh synthetic OPERATOR_ADMIN in the owned RC DB under the existing root operator, tenantId=null, fresh bcrypt password and enrolled TOTP, with a strict USER_CREATED audit marked fixture. Credentials remain private at runtime-directory/operator-credentials.json. This establishes test-fixture setup only, not supported product operator-bootstrap acceptance. Browser must still prove real sign-in/TOTP/session/host isolation. Private launcher sets OPERATOR_APP_HOST to operator.localhost with the unique candidate port; ordinary staff origin remains 127.0.0.1.

Private candidate4 build/runtime uses the documented demo Turnstile TESTsitekey `1x00000000000000000000AA` and TESTsecret `1x0000000000000000000000000000000AA`, explicitly approved by coordinator for synthetic acceptance. Record these non-secret build inputs in image provenance; anti-bot protection is simulated, not production-accepted. SMTP delivery is to an isolated non-relaying local sink only; recovery evidence consumes actual delivered messages through a private MIME adapter and preserves no tokens in tracked artifacts.
