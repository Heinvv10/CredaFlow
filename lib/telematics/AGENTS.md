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
- Only devices on an asset under an agreement are polled: a running loan, or a deal awaiting payout
  (`PRE_BOOKING_DEAL_STATUSES`: heartbeat only, no position, alert or reading before booking).
- The only idempotency key is (tenant, provider, providerEventId): `ingest.ts` locks the device row, inserts
  ON CONFLICT DO NOTHING (`event-insert.ts`, raw: the SQLSTATE is structured) and stops on a duplicate. Only an
  event refused for what it is (`event-shape.ts`, or the event insert's own refusal) is skipped and audited, the
  cursor past it; a passing fault retries for good; a refusal no rule names strikes, three on one event skip
  it. Never classify by message text. `simulated` is the registered provider's flag, never its answer.

## Meter readings
- A tracker reading goes through `recordMeterReading`'s telematics arm (source TELEMATICS), never a raw insert:
  running operating or full-maintenance lease only, one a day (a held reading counts), before the term end,
  within the pace ceiling (`paceCeiling`, SQL twin `telematicsPaceCeiling`). Monotonic or pace refusals become a
  held reading; accepting one needs a note. A real provider's device feeds nothing until staff verify its meter
  (`verifyTrackerMeter`, METER_UNVERIFIED). `guardTelematicsMeterReading` repeats it all.

## Position (POPIA)
- Collection ends with the agreement: a position is stored, and an alert raised, only while a loan's tenure
  covers the event (`telematicsLoanAt`, DB-enforced; ended by the loan's own dated records, never the asset's
  lessor status). One position per device, the latest. An event older than retention is refused.
- `position-view.ts` is the only read path for a coordinate (`position-read-path.test.ts`): view_asset_position
  (never READONLY, INSURANCE_OFFICER or a dealer), a purpose the loan has now (DEFAULT, RECOVERY, LEGAL_MATTER),
  its own tenure (ends at the next loan, its closing or a recovery), within retention, and an access row written
  before the answer, audited TELEMATICS_POSITION_VIEWED; a 403 or 409 TELEMATICS_POSITION_REFUSED. The panels
  show the button only when `position-purpose.ts` says the reveal would answer. Never render a position with a page.
- Retention is `TenantConfig.telematicsPositionRetentionDays` (CHECK 1..365); `purge.ts` deletes nightly.

## Boundaries
- Nothing here sends a message (`no-outbound.test.ts`); an alert is a TelematicsAlert work item (SERVICING,
  COLLECTIONS only in default, RECOVERY with an open recovery or matter).
- The payout checklist never reads telematics (`payout-isolation.test.ts`): a heartbeat is shown beside the
  tracker item, never instead of the TRACKER_CERTIFICATE.
