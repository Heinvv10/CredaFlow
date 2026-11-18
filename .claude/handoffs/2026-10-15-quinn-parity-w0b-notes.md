# W0b (RLS activation) notes collected during merges — 2026-10-15
- Collections cron lists enabled tenants with a frameless query; under app.rls_strict=on it must use withoutTenantScope first (PR #79 comment).
- Collections IT suites run as an ad-hoc RLS-bound non-superuser role: 5 failures, 3 of which also fail with TENANT_RLS off → role privileges/session settings; must be resolved as part of the app-role switch.
- Health detail gate should require totpVerified + active operator.
- Add to RLS checklist: MaintenanceFund, MaintenanceFundMovement, MaintenanceClaim, AssetMeterReading, LeaseEndOfTerm, LeaseDamageItem, LeaseExpiryNotice, LeaseTerminationQuote, WebhookOutboxFailure, ScreeningBlock, ApiRequestLog; W6 payout/accounting models are not tenant-scoped (manual tenantId filters) — decide.
