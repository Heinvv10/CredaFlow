import type { TelematicsAlertKind, TelematicsAlertQueue, TelematicsAlertStatus, TelematicsHeldReason } from "@prisma/client"

export const ALERT_KIND_LABELS: Record<TelematicsAlertKind, string> = { TAMPER: "Tamper", POWER_CUT: "Power cut", GEOFENCE_EXIT: "Geofence exit" }
export const ALERT_QUEUE_LABELS: Record<TelematicsAlertQueue, string> = { SERVICING: "Servicing", COLLECTIONS: "Collections", RECOVERY: "Recovery" }
export const ALERT_STATUS_LABELS: Record<TelematicsAlertStatus, string> = { OPEN: "Open", ACKNOWLEDGED: "Acknowledged", RESOLVED: "Resolved" }
export const HELD_REASON_LABELS: Record<TelematicsHeldReason, string> = {
  LOWER: "Below an earlier reading",
  ABOVE_LATER: "Above a later reading",
  IMPLAUSIBLE: "Far above the contracted pace",
}
