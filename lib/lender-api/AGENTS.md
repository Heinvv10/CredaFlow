<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# lib/lender-api — the public lender API and outbound webhooks

- Every `app/api/v1/*` handler goes through `withApiKey(req, scope, …)`
  (`lib/lender-api/handler.ts`). It is the authentication: `proxy.ts` lets
  `/api/v1/*` through without a session, on the staff host only.
- The tenant comes from the key row, never from a header or the host. Handlers
  run inside `runWithTenant(key.tenantId)` and still pass `tenantId` explicitly.
- A Prisma query run in `withoutTenantScope` / `runWithTenant` must be AWAITED
  inside the callback: a PrismaPromise is lazy, and returned un-awaited it runs
  after the frame has closed.
- Responses come from `serializers.ts` with an explicit `select`. A client's full
  ID number, email, phone and date of birth need the `pii:read` scope, and so
  does any free text (application purpose, payment reference).
- Rate limits are per key. Never add a limit that a caller without a valid key
  can fill for everyone (an IP bucket on all requests did: review B1).
- A key is refused once its creator is inactive or below ADMIN
  (`keyIssuerStillAuthorised`). Paging is keyset on (createdAt, id): never a
  Prisma `cursor: { id }`, which reads the named row without the tenant filter.
- A new route, method or scope must be added to `openapi.ts`;
  `openapi.test.ts` fails otherwise. Scopes live in three places: `scopes.ts`,
  `ApiKey_scopes_check` (migration `20261014150000_lender_api_webhooks`) and the
  OpenAPI security scheme.
- No money writes (recording payments, disbursing) through the API: they need
  their own design (idempotency, allocation, audit, 2FA-equivalent).
- Webhook events are written by database triggers (same migration) into
  `WebhookEvent`, only while the tenant has an active endpoint for the type.
  Adding an event type changes the trigger SQL, `WebhookEndpoint_events_check`
  and `webhooks/events.ts` together.
- The dispatcher's `running` flag only stops overlapping runs in ONE process.
  Across replicas, safety comes from the database: fan-out claims events
  `FOR UPDATE SKIP LOCKED`, and a delivery is claimed by moving its
  `nextAttemptAt` forward (a lease) in an UPDATE that re-checks it is still due.
- Webhook URLs go through `webhooks/ssrf.ts` twice: at save
  (`assertWebhookUrl`) and inside the connection's own DNS lookup
  (`guardedLookup`). Never POST to a lender URL any other way.
- Key and endpoint changes write their audit row in the same transaction
  (`key-admin.ts`, `webhooks/endpoints.ts`); never put a key or a signing
  secret in an audit row or a log.
- Integration suites: `RUN_API_IT=1` (`lender-api.integration.test.ts`,
  `lender-api-hardening.integration.test.ts`).
