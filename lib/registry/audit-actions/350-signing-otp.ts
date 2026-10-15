import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Signing OTP and portal registration policy (lib/signing-otp,
  // lib/portal/portal-policy.ts). Never the code itself.
  PORTAL_POLICY_UPDATED: "PORTAL_POLICY_UPDATED",
  SIGNING_OTP_REQUESTED: "SIGNING_OTP_REQUESTED",
  SIGNING_OTP_VERIFIED: "SIGNING_OTP_VERIFIED",
  SIGNING_OTP_REJECTED: "SIGNING_OTP_REJECTED",
})
