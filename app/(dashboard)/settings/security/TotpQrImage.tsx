/** The enrolment QR, or a note pointing at the manual key when it is unavailable. */
export function TotpQrImage({ qrUrl }: { qrUrl: string | null }) {
  if (!qrUrl) {
    return (
      <div className="w-[180px] border rounded-lg p-3 text-sm text-gray-600">
        QR unavailable — enter the key manually
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={qrUrl}
      alt="QR code for authenticator app"
      width={180}
      height={180}
      className="border rounded-lg"
    />
  )
}
