import { defineAuditActions } from "../define"

export default defineAuditActions({
  // WhatsApp bridge pool
  WA_BRIDGE_NUMBER_ADDED: "WA_BRIDGE_NUMBER_ADDED",
  WA_BRIDGE_NUMBER_REORDERED: "WA_BRIDGE_NUMBER_REORDERED",
  WA_BRIDGE_NUMBER_PROMOTED: "WA_BRIDGE_NUMBER_PROMOTED",
  WA_BRIDGE_NUMBER_RETIRED: "WA_BRIDGE_NUMBER_RETIRED",
  // Re-pairing a revoked session. Distinct from ADDED: no new number entered
  // the pool, so an auditor reading ADDED rows sees only genuinely new numbers.
  WA_BRIDGE_NUMBER_RELINKED: "WA_BRIDGE_NUMBER_RELINKED",
  // Parked / un-parked. Distinct from RETIRED because the session survives —
  // an auditor asking "when did this number stop sending" needs to tell a
  // reversible bench from a destroyed pairing.
  WA_BRIDGE_NUMBER_PAUSED: "WA_BRIDGE_NUMBER_PAUSED",
  WA_BRIDGE_NUMBER_RESUMED: "WA_BRIDGE_NUMBER_RESUMED",
  // A WhatsApp outage was detected and NOT ONE recipient could be reached.
  // Email is currently the only alerting channel (the dashboard banner was
  // descoped), so this row is the last remaining trace that the detector
  // worked and the notification did not — otherwise the failure is a
  // console.error in an unretained container log, which is indistinguishable
  // from the six-day silence this whole feature exists to prevent.
  WA_BRIDGE_ALERT_UNDELIVERABLE: "WA_BRIDGE_ALERT_UNDELIVERABLE",
})
