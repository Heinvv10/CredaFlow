import { isRegimeOpen } from "@/lib/asset-finance/classification"
import { NcaOverrideRequestForm } from "./NcaOverrideRequestForm"

/**
 * The manual "this deal is outside the NCA" request (DESIGN D5), for a user
 * with manage_asset_finance while the application is still open, classified
 * NCA and has no request pending. It never applies on its own: a different
 * user with decide_asset_finance approves it (OverrideDecision). The API
 * re-checks every condition (app/api/asset-finance/applications/[id]/nca-overrides).
 */
export function NcaOverrideRequest(props: {
  application: { id: string; status: string; ncaRegime: string | null }
  pendingOverride: boolean
  canManage: boolean
}) {
  const { application } = props
  const open = props.canManage && !props.pendingOverride && application.ncaRegime === "NCA" && isRegimeOpen(application.status)
  return open ? <NcaOverrideRequestForm applicationId={application.id} /> : null
}
