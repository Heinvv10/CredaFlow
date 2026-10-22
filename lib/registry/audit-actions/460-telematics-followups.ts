import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Telematics follow-ups (docs/asset-finance/SLICE5-FOLLOWUPS.md part T).
  // A theft report recorded (the THEFT position purpose) and a refused one.
  TELEMATICS_THEFT_REPORT_RECORDED: "TELEMATICS_THEFT_REPORT_RECORDED",
  // A second person confirms it (THEFT holds only then), and it may be ended early (the asset found).
  TELEMATICS_THEFT_REPORT_CONFIRMED: "TELEMATICS_THEFT_REPORT_CONFIRMED",
  TELEMATICS_THEFT_REPORT_ENDED: "TELEMATICS_THEFT_REPORT_ENDED",
  // A position trail shown (beside its access row, no coordinate in the audit).
  TELEMATICS_POSITION_TRAIL_VIEWED: "TELEMATICS_POSITION_TRAIL_VIEWED",
  // The four-eyes void of a meter reading.
  METER_READING_VOID_REQUESTED: "METER_READING_VOID_REQUESTED",
  METER_READING_VOID_APPROVED: "METER_READING_VOID_APPROVED",
  METER_READING_VOID_REJECTED: "METER_READING_VOID_REJECTED",
  // A tracker on a completed loan: each closure step (system). Its removal is TRACKER_DEVICE_REMOVED.
  TRACKER_CLOSURE_NOTICE_LOGGED: "TRACKER_CLOSURE_NOTICE_LOGGED",
  TRACKER_CLOSURE_MESSAGE_DECIDED: "TRACKER_CLOSURE_MESSAGE_DECIDED",
  TRACKER_CLOSURE_LETTER_STORED: "TRACKER_CLOSURE_LETTER_STORED",
} as const)
