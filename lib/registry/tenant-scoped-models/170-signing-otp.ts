import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Signing OTP challenges (lib/signing-otp). Non-null tenantId, passed
  // explicitly on every query (sign routes run inside withTenantContext too).
  "SigningOtpChallenge",
] as const)
