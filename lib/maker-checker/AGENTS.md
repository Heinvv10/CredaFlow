<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: maker-checker
<!-- summary: generic four-eyes change requests for configuration; maker is never checker, enforced in the database -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
One reusable mechanism for lender configuration that must not change on one
person's word: draft -> submitted -> approved | rejected (or withdrawn). The
approved payload is applied in the same transaction as the approval. First
consumers: decision rule sets and engine settings (`lib/decisioning/`).

## Contract for a consumer (A5 product versions, A6 approval matrix, ...)
1. Write a `ChangeHandler<P>` (`types.ts`): `kind` (UPPER_SNAKE, 3-60), `label`,
   `payloadVersion` (bump when `parse` changes meaning: older drafts then refuse
   to approve), `makePermission`, `approvePermission` (a permission key, or a
   function of the payload, e.g. by amount), `parse(raw)` (pure; throw
   `InvalidPayloadError(problems)`; return the normalised stored payload),
   optional `verify(tx, tenantId, payload)` (DB checks; runs on submit AND again
   inside the approval), optional `baseRef(tx, tenantId, payload)` (see below),
   and `apply(tx, { tenantId, request, payload, checker, now })`.
2. Register it: one file in `lib/registry/change-handlers/` naming the module and
   export (data only; the generator writes the import). No central map to edit.
3. Add audit actions and permissions via their registries; write audit rows in
   `apply` with the same `tx`. `apply` throwing rolls the approval back.
4. Call `service.ts` (`createDraft`, `updateDraft`, `submit`, `approve`, `reject`,
   `withdraw`, `listChangeRequests`) or the generic routes `app/api/maker-checker/**`
   (they gate on the handler's own permissions, not a role floor). Never write
   `ChangeRequest` rows directly.

## Critical Rules
- **Maker is not checker**: CHECK `ChangeRequest_four_eyes`; the service answers
  `SELF_APPROVAL` first. Do not add a path that approves as a system user.
- **Two people, not two accounts**: a maker account younger than 30 days that a tenant user
  created (USER_CREATED) or SSO provisioned (SSO_USER_PROVISIONED) cannot have changes approved
  (operator-provisioned, bootstrap and seeded accounts leave no such row and are exempt; a
  HIGH-RISK payload needs a 30-day-old maker account whatever its origin). An account whose SSO
  identity, second factor (a first enrolment within 7 days of the account's creation is setup, not a change; a replacement, disable, reset or
  re-enrolment after one is), role, email or password changed in the last 30 days is refused whoever
  wrote the row (audit trail: SSO_*, TOTP_*, USER_UPDATED with role/email/`passwordChanged`; read
  in pages newest first, and a trail over 5000 rows is refused, never approved unseen), and a checker who created the maker's account or changed it (USER_CREATED,
  USER_UPDATED, TOTP_RESET_BY_ADMIN in the audit log) in the last 30 days is refused
  (`MAKER_ACCOUNT_CONTROLLED`). A handler's `approvePermission` (and optional `makePermissionFor`)
  can depend on the payload to put a high-risk change (engine LIVE, s71 sign-off) on a higher role.
- **Step-up 2FA**: `approve` and `reject` refuse (`TOTP_REQUIRED`) a session that
  did not verify a TOTP code when the lender requires staff TOTP. Pass
  `actor.totpVerified` (a `StaffUser` carries it).
- **Stale approval**: if the handler has `baseRef`, it is recorded at submit and
  compared inside the approval; a change drafted against a state that has moved
  is `STALE` (409). Approvals of one kind per lender are serialised by an advisory
  lock, so the check and `apply` see one state. Use it wherever "approve over a
  newer change" would silently undo it (versions, settings).
- **Older drafts**: a draft whose `payloadVersion` is not the handler's cannot be
  submitted or approved (`STALE`, 409); editing its payload re-stamps it.
- **The payload is frozen at submission** (trigger `guardChangeRequest`); no
  delete, no truncate; a mistake is a new request.
- **Provenance for what `apply` writes**: the table should refuse rows no approved
  request of this kind made (`guardDecisionRuleSetVersion`,
  `guardDecisionEngineConfig`). Store `changeRequestId` as plain text; add no
  relation to `ChangeRequest`.
- Lists run their filters in the database and are paged (`listChangeRequests`).

## Tests
`RUN_MAKER_CHECKER_IT=1`: `maker-checker.integration.test.ts` (CHECKs, triggers,
atomic rollback, concurrent and stale approvals, provenance). `service.test.ts`
and `handlers.test.ts` (every registered handler meets the contract) are mocked.
