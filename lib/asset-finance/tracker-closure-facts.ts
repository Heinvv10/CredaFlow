/**
 * The facts the "tracking stopped" notice is written from (SLICE5-FOLLOWUPS.md part T), one source for the email,
 * the letter (./tracker-closure.ts) and the portal card (components/asset-finance/telematics/PortalTrackingStopped.tsx).
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatIsoDatePdf } from "./documents/pdf-layout"
import type { TrackingStoppedFacts } from "./documents/wording/tracking-stopped"

export interface ClosureFactsInput {
  closedAt: Date
  loan: { reference: string; entity: { legalName: string } | null; asset: { make: string; model: string; serialNumber: string } | null }
}

export async function trackingStoppedFactsOf(tenantId: string, lenderName: string, closure: ClosureFactsInput): Promise<TrackingStoppedFacts> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { telematicsPositionRetentionDays: true } })
  const asset = closure.loan.asset
  return {
    lenderName, loanReference: closure.loan.reference,
    assetDescription: asset ? `${asset.make} ${asset.model} (${asset.serialNumber})` : "financed asset",
    endedOn: formatIsoDatePdf(sastCalendarDate(closure.closedAt)),
    entityName: closure.loan.entity?.legalName ?? null,
    retentionDays: config?.telematicsPositionRetentionDays ?? 90,
  }
}
