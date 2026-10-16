import { defineAuditActions } from "../define"

export default defineAuditActions({
  // The signed-in client opened a one-time selfie capture link to continue on
  // their phone (no camera on this device; POST /api/portal/selfie-link). No
  // message was sent: the link was shown to them as a QR code.
  SELFIE_LINK_PORTAL_HANDOFF: "SELFIE_LINK_PORTAL_HANDOFF",
  // Live capture links (e.g. one staff sent) cancelled because a newer link
  // replaced them: only one link per application works at a time.
  SELFIE_LINK_INVALIDATED: "SELFIE_LINK_INVALIDATED",
})
