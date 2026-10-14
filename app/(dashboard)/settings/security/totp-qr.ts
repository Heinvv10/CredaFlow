import QRCode from "qrcode"

/**
 * Renders the otpauth URI (which carries the TOTP secret) as a PNG data URL
 * in-process. The URI must never be sent to a third-party QR service.
 */
export function otpauthQrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth, { width: 360, margin: 2, errorCorrectionLevel: "M" })
}
