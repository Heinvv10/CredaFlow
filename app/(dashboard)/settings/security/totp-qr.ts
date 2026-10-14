import QRCode from "qrcode"

/**
 * Renders the otpauth URI (which carries the TOTP secret) as a PNG data URL
 * in-process. The URI must never be sent to a third-party QR service.
 */
export function otpauthQrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth, { width: 360, margin: 2, errorCorrectionLevel: "M" })
}

export interface TotpSetupData {
  secret: string
  otpauth: string
  /** Null when the QR could not be generated: the user enters the key manually. */
  qrUrl: string | null
}

/** A QR failure must not discard the secret the server just issued. */
export async function buildTotpSetup(
  data: { secret: string; otpauth: string },
  toQr: (otpauth: string) => Promise<string> = otpauthQrDataUrl,
): Promise<TotpSetupData> {
  try {
    return { ...data, qrUrl: await toQr(data.otpauth) }
  } catch {
    return { ...data, qrUrl: null }
  }
}
