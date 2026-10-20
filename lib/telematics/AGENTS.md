<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: tracker/telematics (spec: docs/asset-finance/SLICE5.md Part B)
<!-- summary: simulated tracker provider, idempotent ingest, held meter readings, alert work items, logged position view, POPIA purge -->

## Provider and ingest
- No real provider. `providers/simulated.ts` checks `assertSimulationAllowed("simulated-telematics")` on every
  poll and registration; a deployed build needs `SIMULATED_INTEGRATIONS=simulated-telematics` (demo stacks only).
  Timelines are a pure function of the device id (`SIM-<SCENARIO>-<n>`), install date and now.
- The only idempotency key is (tenant, provider, providerEventId): `ingest.ts` inserts ON CONFLICT DO NOTHING
  and stops on a duplicate. A device's cursor moves only when all its events were stored.

## Meter readings
- A tracker reading goes through `recordMeterReading`'s telematics arm (source TELEMATICS), never a raw insert:
  running operating or full-maintenance lease only, one a day, before the term end, within the pace ceiling
  (`paceCeiling`, SQL twin `telematicsPaceCeiling`). Monotonic or pace refusals become a held reading.
  `guardTelematicsMeterReading` repeats it all. A lower reading is never accepted, only rejected.

## Position (POPIA)
- `position-view.ts` is the only read path for a coordinate (`position-read-path.test.ts`): view_asset_position
  (never READONLY, INSURANCE_OFFICER or a dealer), a loan in default, legal action or recovery, its own tenure,
  within retention, and an access row written before the answer. Never render a position with a page.
- Retention is `TenantConfig.telematicsPositionRetentionDays` (CHECK 1..365); `purge.ts` deletes nightly.

## Boundaries
- Nothing here sends a message (`no-outbound.test.ts`); an alert is a TelematicsAlert work item.
- The payout checklist never reads telematics (`payout-isolation.test.ts`): a heartbeat is shown beside the
  tracker item, never instead of the TRACKER_CERTIFICATE.
