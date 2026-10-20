/**
 * A dealer's structure quote: the body a create takes (lib/asset-finance/
 * deal-input.ts), priced by the shared solver (lib/asset-finance/deal-preview.ts)
 * for an asset this dealer captured. Any other asset is "not found". Writes
 * nothing.
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { parseDealPreview } from "@/lib/asset-finance/deal-input"
import { previewDealStructure, type DealPreviewAnswer } from "@/lib/asset-finance/deal-preview"
import type { DealerActor } from "./actor"

export async function previewDealerDeal(actor: DealerActor, body: unknown): Promise<DealPreviewAnswer | { status: 404; body: { error: string } }> {
  const parsed = parseDealPreview(body, sastCalendarDate(new Date()))
  if ("errors" in parsed) return { status: 400, body: { error: "Invalid structure", fields: parsed.errors } }
  const asset = await prisma.financedAsset.findFirst({
    where: { id: parsed.data.assetId, tenantId: actor.tenantId, createdByDealerId: actor.dealerId },
    select: { cashPriceExclVatCents: true, vatCents: true },
  })
  if (!asset) return { status: 404, body: { error: "Asset not found" } }
  return previewDealStructure(actor.tenantId, parsed.data, asset)
}
