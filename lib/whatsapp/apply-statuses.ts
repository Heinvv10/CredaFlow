import { prisma } from "@/lib/prisma"
import type { MsgStatus } from "@prisma/client"
import type { WabaStatus } from "./waba-payload"

export function mapWabaStatus(status: string): MsgStatus | null {
  switch (status) {
    case "sent": return "SENT"
    case "delivered": return "DELIVERED"
    case "read": return "READ"
    case "failed": return "FAILED"
    default: return null
  }
}

/**
 * Applies Meta delivery receipts to outbound Messages. Idempotent: a
 * redelivered receipt re-sets the same status. Never advances READ back to
 * DELIVERED because Meta only ever sends forward-moving receipts, but we do
 * not enforce ordering here — last write wins, which matches Meta's semantics.
 */
export async function applyWabaStatuses(tenantId: string, statuses: WabaStatus[]): Promise<void> {
  for (const s of statuses) {
    const mapped = mapWabaStatus(s.status)
    if (!mapped) continue
    await prisma.message.updateMany({
      where: { tenantId, provider: "WA_CLOUD", providerMessageId: s.providerMessageId },
      data: { status: mapped },
    })
  }
}
