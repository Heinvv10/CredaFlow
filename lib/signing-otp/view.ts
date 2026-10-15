import { availableOtpChannels, type OtpChannel, type OtpRecipient } from "./deliver"
import { isSigningOtpRequired, type SigningMethod } from "./policy"

/** What a signing page needs to render the OTP step (SigningOtpStep). */
export type SigningOtpView = { required: boolean; channels: OtpChannel[] }

export async function signingOtpView(
  tenantId: string,
  recipient: OtpRecipient,
  method: SigningMethod,
): Promise<SigningOtpView> {
  if (!(await isSigningOtpRequired(tenantId, method))) return { required: false, channels: [] }
  return { required: true, channels: await availableOtpChannels(tenantId, recipient) }
}
