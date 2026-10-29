<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: lib/audit/ (tamper-evident audit, SIEM)
<!-- summary: AuditLog is append-only; a keyed chainer links committed rows; verifier, checkpoints, redaction, SIEM -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Append-only in the database, chained after commit (migrations 20261029100000/100)
- `AuditLog` refuses UPDATE/DELETE/TRUNCATE. Its user/tenant FKs are RESTRICT: a user or
  lender with audit rows is deactivated, never deleted. The one exception is
  `audit_log_redact()` (below). An insert does no chain work: no lock, no read.
- The chainer (`chainer.ts`, cron `audit-chainer`, a pass every 5 s) appends an
  `AuditChainLink` (insert-only) per COMMITTED row: `rowHash` = HMAC(`AUDIT_CHAIN_KEY`,
  position + prevHash + the row's ids and digests, `chain-hash.ts`). One chain per tenant,
  `''` = no tenant. `pg_try_advisory_xact_lock` per chain; chain order = commit-observed order.
  Rolled-back and ON CONFLICT-skipped rows never appear. A chain with no link is chained from
  its first row (that is the backfill); else only rows newer than 24 h are looked for.
- No `AUDIT_CHAIN_KEY` (32+ chars): chainer and verifier refuse (503). Keep it out of the database.
- Tests purge with `audit-rows.test-helpers.ts` on the OWNER connection (also links, redactions, outbox, checkpoints).

## Verifying (`chain-verify.ts`)
Breaks: `seq_gap`, `prev_hash_mismatch`, `row_hash_mismatch`, `row_missing`, `unchained_row`
(older than 24 h), `checkpoint_invalid`, `checkpoint_mismatch`. `incremental` starts at the latest
checkpoint (cheap; does not re-read before it), `full` from the genesis. Daily cron
`audit-chain-verify` (02:30): one chainer pass, incremental (full on Sundays SAST), a checkpoint
per chain that held (queued to the SIEM), `AUDIT_CHAIN_BROKEN`/`_VERIFIED` rows. `npm run audit:verify`
(full; `-- --incremental`), `GET/POST /api/admin/audit/verify` (ADMIN, own lender; POST is incremental, 6/h).
Database AND key can rewrite everything; the SIEM's copy and checkpoints are the defence.

## Redaction (POPIA)
`audit_log_redact(id, cols, reason, operator)` (SECURITY DEFINER, not PUBLIC) nulls userEmail/ipAddress/
oldValue/newValue, keeps the digests in `AuditRedaction` so the link still verifies, writes
`AUDIT_ROW_REDACTED`. Owned by NOLOGIN `audit_redactor`; the trigger accepts a redaction only as that role
with an `AuditRedaction` row (no session flag). Run by `npm run audit:redact` with an operator role.
Two logins: migrations run as the table OWNER; the app as a non-owner with INSERT/SELECT on AuditLog and NO
privilege on link/checkpoint/redaction/outbox (`audit_grant_runtime(role)` via `deploy/helm/credaflow/files/app-role.sql`,
re-run after each migration). Those tables are reached only through `store.ts` -> SECURITY DEFINER `audit_*`
functions: a new query on them is a new function, never a grant. `deployment-check.ts` warns at boot and on /api/health.

## SIEM (`siem/`)
- `AuditPolicy` per lender (not TenantConfig); sealed secrets (`WABA_ENC_KEY`). `PUT /api/settings/audit-policy`
  (ADMIN, TOTP where required); `POST` sends a test (TOTP, 5/h, audited, error class only).
- The chainer fills `AuditSiemOutbox` while `siemEnabled`; `deliver.ts` ships in `id` order per lender under
  an advisory lock, stops at the first failed batch (30 s doubling to 1 h), splits a 4xx-rejected batch
  down to the bad row (dead after 3). The `AuditPolicy` trigger stamps `targetSnapshot` (the OLD
  destination) on everything queued when forwarding moves/stops; rows created before the change but chained
  after get it too; a new destination starts with an ANCHOR. The outbox functions take no destination or
  cutoff from the caller; `mark` writes `AuditSiemDelivery` receipts. Prune/purge: see ARCHITECTURE.
- Minimised (`minimise.ts`): action, entity, entityId, actor id, tenant, time, seq/hash; values and source IP
  only for `VALUE_ACTIONS`, masked. Never the email. Syslog = RFC 5424 over TLS (CEF body); delivered
  when the socket closes cleanly; HTTPS = JSON batch, 2xx = ack. At-least-once, `eventId` de-duplicates.
- Destinations public only; `AUDIT_SIEM_ALLOW_PRIVATE=1` admits private ranges, never loopback/link-local.
  Syslog SD id `cf@<AUDIT_SYSLOG_PEN>` (default 32473, the documentation number: set yours).
- Security events (`security-events.ts`): staff sign-in/failure/TOTP failure (`lib/auth.ts`, staff branch only) and
  `requireApiRole` denials of staff; explicit tenant and user; failures one row per (tenant, user, kind, ip) per 5 min; a success is never suppressed. Not portal
  clients, operator, dealer or other guards.
