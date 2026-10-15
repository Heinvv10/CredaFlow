<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: integrations
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Third-party API clients for SA-specific lending workflows: SmileIdentity
(KYC), TransUnion (credit bureau), BulkSMS (SMS delivery), Netcash
(payment alternative). Each file is a thin client around the vendor's HTTP API.

## Critical Rules
- **Credentials live in env, never in code.** Each integration has its own
  `*_API_KEY` / `*_USERNAME` / `*_PASSWORD` env vars (see `.env.example`).
  Don't log them, don't echo them in errors.
- **TransUnion calls cost real money.** Cache the response per client/loan
  application — don't pull a fresh report on every page render. The
  legitimate trigger is application submission, not browsing.
- **SmileIdentity result is the KYC source of truth.** Map their pass/fail
  to `Client.kycStatus` (enum `KycStatus`) — never set `KYC_PASSED` from
  any other path.
- **All outbound integration calls are audit-logged.** Use `lib/audit.ts`;
  vendor failures must surface to the user, not be silently retried.
- **Rate limits are real.** BulkSMS quotes a per-minute cap — when sending
  campaign-style messages, batch and pace.
- **`sendSms()` refuses while the SMS channel is off** (`BULKSMS_DRY_RUN`),
  returning a `DEFINITELY_REJECTED` result without touching the provider. SMS
  is off by policy — see the messaging module's own rules. `sendWhatsApp()`
  shares the transport but NOT that guard: the channels switch independently
  and WhatsApp is on.
- **Collection scheme rules live in the engine, not adapters.** Presentment
  caps and NPF stop rules are compliance boundaries (spec 2026-07-10) —
  adapters only translate wire formats.

## Key Files
| File | Purpose |
|------|---------|
| `lib/integrations/smileidentity.ts` | KYC verification (ID, selfie, liveness) |
| `lib/integrations/transunion.ts` | Credit bureau enquiry — pulls bureau score + accounts. Callers go through `lib/bureau/` (provider registry, fallback), not this client |
| `lib/integrations/bulksms.ts` | SMS delivery (transactional + reminder) |
| `lib/integrations/netcash.ts` | Alternative payment processor (Stitch is primary — see `lib/stitch.ts`) |
| `lib/integrations/collections/` | Pluggable collection rail (DebiCheck/debit-order/AVS). Adapters behind `CollectionProvider`; registry keyed by `TenantConfig.collectionProvider`. NO provider-specific code outside its adapter file. |

## Dependencies
- **External:** SmileIdentity API, TransUnion ITC, BulkSMS HTTPS API, Netcash
- **Internal:** `@/lib/audit`, `@/lib/prisma` (for caching results)

## Common Tasks
| Task | Pattern |
|------|---------|
| KYC a new client | `await runSmileVerification({ idNumber, selfieB64 })` |
| Pull credit bureau | `await fetchTransUnionReport({ idNumber, applicationId })` (cache the result) |
| Send SMS reminder | `await sendBulkSms({ to, message, tenantId })` |

---
<!-- Hand-written 2026-04-29. Refresh via /kb when files change. -->
