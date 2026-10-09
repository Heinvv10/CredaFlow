import {
  resolveSelfieLinkToken,
  SELFIE_LINK_REJECTION_MESSAGE,
} from "@/lib/kyc/selfie-link-token.server"
import { SelfieLinkCapture } from "./SelfieLinkCapture"

export const dynamic = "force-dynamic"

/**
 * Consumer landing page for a one-time selfie capture link.
 *
 * Public by way of proxy.ts (`isSelfieLinkPage`), for the same reason
 * /pasq/[token] is: the person opening it has no portal account and usually
 * never will. The token is resolved server-side, so an invalid link renders a
 * refusal and nothing else — no camera, no application detail.
 */
export default async function SelfieLinkPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const resolved = await resolveSelfieLinkToken(token)

  if (!resolved.ok) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold">This link cannot be opened</h1>
        <p className="mt-2 text-sm">{SELFIE_LINK_REJECTION_MESSAGE[resolved.reason]}</p>
      </div>
    )
  }

  return <SelfieLinkCapture token={token} firstName={resolved.link.clientFirstName} />
}
