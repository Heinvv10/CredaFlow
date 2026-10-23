import type { ValuationGuideStatus } from "@prisma/client"
import type { Tone } from "@/lib/asset-finance/deal-labels"

export const GUIDE_STATUS_LABELS: Record<ValuationGuideStatus, string> = {
  DRAFT: "Draft", PUBLISHED: "Current", SUPERSEDED: "Superseded", DISCARDED: "Discarded",
}

export const GUIDE_STATUS_TONE: Record<ValuationGuideStatus, Tone> = {
  DRAFT: "warning", PUBLISHED: "success", SUPERSEDED: "neutral", DISCARDED: "neutral",
}
