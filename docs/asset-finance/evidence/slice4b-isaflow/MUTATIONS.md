# Slice 4b part 2 (IsaFlow push): mutation record

Each guard and each piece of key logic was broken on purpose, one at a time. The suite that
should catch it was run, and the code was put back. Run on 2026-10-16 in the worktree
`feat/af-isaflow-push`, against a throwaway Postgres 16 (`scripts/it-db.sh`, migrated with every
migration) and the fake IsaFlow server.

- **Code mutations** edit the source file and restore it afterwards.
- **Database mutations** work directly on the throwaway database:
  - a trigger function is replaced with `CREATE OR REPLACE FUNCTION` (mutated body), then the
    migration's own body is restored;
  - a CHECK constraint is dropped, then added back.

Suites:

- `client` = `lib/accounting/isaflow/client.test.ts`
- `journal` = `lib/accounting/isaflow/journal.test.ts`
- `it` = `lib/accounting/isaflow/isaflow.integration.test.ts`
- `guards` = `lib/accounting/isaflow/isaflow-guards.integration.test.ts`
- `conn_route` = `app/api/integrations/isaflow/route.test.ts`
- `push_route` = `app/api/accounting/batches/[id]/isaflow/route.test.ts`

The ITs ran with `RUN_ACCOUNTING_IT=1`.

**Every mutation below turned its suite red.**

| # | Mutation | Suite | Result: failing test(s) |
|---|---|---|---|
| C1 | client: a 5xx is called `definite` instead of `unknown` | client | RED: "says whether a failed request could have taken effect" |
| C2 | client: a tool refusal (`isError`) is read as success | client | RED: "says whether…", "carries IsaFlow's refusal text, never the token" |
| C3 | base URL: the `ISAFLOW_ALLOWED_ORIGINS` allow-list is not checked | client | RED: "refuses a base URL this deployment does not allow before any request" |
| D1 | dial: the connection resolves the host itself (no `guardedLookup`), as plain fetch did | client | RED: "dials only the address it checked: a name that re-points to a private address at dial time is refused (DNS rebinding)" |
| D2 | client: production requests go through plain fetch (the guarded dial bypassed) | client | RED: the same test |
| J1 | rands truncated to whole rands | journal | RED: "writes rands to two decimals", "builds one stable request…", "finds the draft on read-back…" |
| J2 | read-back matches on the memo tag alone, ignoring the lines | journal | RED: "finds the draft on read-back by its memo tag and identical lines…" |
| J3 | an inactive IsaFlow account is accepted | it | RED: "refuses a code IsaFlow lacks or has inactive with a 422…" |
| P1 | a role without a stored mapping to the line's code is not refused | it | RED: "refuses a role without a stored mapping…before any request", plus 3 later tests |
| P2 | the IsaFlow chart check is skipped | it | RED: "refuses a code IsaFlow lacks or has inactive…", plus 2 later tests |
| P3 | an already PUSHED batch is not refused before IsaFlow is called | it | RED: "two pushes give one draft…" |
| R1 | no read-back before a resend | it | RED: "an unknown outcome…check finds the draft on read-back…without a second create", "a FAILED push is read back…" |
| R2 | the resend uses a fresh key instead of the stored bytes | it | RED: "a draft deleted in IsaFlow is resent byte for byte under the same key…", plus 2 more |
| S1 | push route: TOTP not required | push_route | RED: "refuses an ADMIN or a SUPER_ADMIN without a verified TOTP code…" |
| S2 | connect: the role is not re-checked on the locked row (`superAdminPolicyWrite`) | conn_route | RED: "refuses a SUPER_ADMIN demoted between the check and the write" |
| S3 | the status (GET) carries the sealed token | conn_route | RED: "is ADMIN's to read and never carries the token" |
| S4 | the connect audit row carries the token | it | RED: "no audit row carries the token" |
| G1 | DB: deleting a push allowed | guards | RED: "is never deleted or truncated" |
| G2 | DB: PUSHED → SENDING allowed | guards | RED: "records an IsaFlow journal id once; PUSHED needs one and is final" |
| G3 | DB: request and its sha256 may change | guards | RED: "never changes its request, hash, key or IsaFlow company" |
| G4 | DB: idempotency key may change (the key CHECK still refuses, with another message) | guards | RED: "never changes its request, hash, key or IsaFlow company" |
| G5 | DB: `isaflowCompanyId` may change | guards | RED: "never changes its request…" |
| G6 | DB: `isaflowJournalId` may be rewritten | guards | RED: "records an IsaFlow journal id once…" |
| G7 | DB: a push may be inserted for a batch that is not CLOSED or not the tenant's | guards | RED: "starts as a SENDING claim on a closed batch of its own tenant…" and later tests |
| G8 | DB: CONNECTED without `connectedWithTotp` | guards | RED: "refuses CONNECTED without a TOTP-verified session…" |
| G9 | DB: CONNECTED by a user who is not a SUPER_ADMIN | guards | RED: "refuses CONNECTED…", "needs a SUPER_ADMIN again to come back from NEEDS_RECONNECT…" |
| G10 | DB: CONNECTED by another tenant's SUPER_ADMIN | guards | RED: the same two |
| G11 | DB: deleting a connection allowed | guards | RED: "is never deleted and stays with its tenant" |
| K1 | DB CHECK `AccountingIsaFlowPush_request_sha256` dropped | guards | RED: "starts as a SENDING claim…bound to the batch's key, reference and request hash" |
| K2 | DB CHECK `IsaFlowConnection_token_sealed_iff_connected` dropped | guards | RED: "stores a token only sealed and only while CONNECTED" |
| K3 | DB CHECK `AccountingIsaFlowPush_idempotency_key_bound` dropped | guards | RED: "starts as a SENDING claim…" |
| K4 | DB CHECK `AccountingIsaFlowPush_pushed_has_journal` dropped | guards | RED: "records an IsaFlow journal id once; PUSHED needs one…" |

## A test that could not fail (found and fixed during this run)

The first database run left G1, G3, G4, G5 and G11 green. The cause was in the test, not the guard.

- Prisma's default error format quotes the calling source line in `error.message`.
- That line contains the assertion's own regex, for example `.rejects.toThrow(/never deleted/)`.
- So the regex always matched its own source text.

The guards suite now uses `new PrismaClient({ errorFormat: "minimal" })`. With that change, all
five mutations went red (the table above).

The same pattern appears in an existing suite: `lib/accounting/xero/xero.integration.test.ts` asserts
`rejects.toThrow(/PUSHED -> SENDING is not allowed/)` on a default-format client. It was not changed
here; it is outside this work package.
