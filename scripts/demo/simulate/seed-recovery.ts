/** Complete only the seed's waiting TLB recovery, using the same guarded API as staff. */
import { addSouthAfricanBusinessDays, southAfricanCalendarDate } from "../../../lib/compliance/sa-business-days"
import { demoLender } from "../../../prisma/demo-lender"
import { ensureActorSessions } from "../servicing/setup"
import { now } from "../sim/clock"
import { runCronJob } from "../sim/cron"
import { readDb } from "../sim/readonly-db"
import type { SimClient } from "../sim/api"
import type { Sim } from "./context"

export async function continueSeedRecovery(sim: Sim): Promise<void> {
  const today = southAfricanCalendarDate(now())
  if (today !== sim.window.until) throw new Error("Seed recovery continuation runs only at the simulated window end")
  const db = readDb()
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: demoLender().slug }, select: { id: true } })
  const load = () => db.recovery.findMany({
    where: { tenantId: tenant.id, route: "NCA_S131_ATTACHMENT", asset: { serialNumber: "MBTLB000000001", vin: "MBX00000000000003" } },
    include: { costs: true, sales: true },
  })
  const rows = await load()
  if (rows.length > 1) throw new Error("The seeded TLB recovery is ambiguous")
  let recovery = rows[0]
  const refreshDpd = async () => {
    const result = await runCronJob({ name: "dpd-update", method: "GET", at: "02:00", cadence: "daily" })
    if (result.status !== 200) throw new Error(`Seed recovery DPD refresh refused: ${result.status}`)
  }
  // A prior run may have committed the outcome before its DPD refresh failed.
  if (recovery?.status === "SHORTFALL_OPEN") { await refreshDpd(); return }
  if (!recovery || !["VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"].includes(recovery.status)) return
  const received = recovery.valuationNoticeReceivedOn
  if (!received || today <= addSouthAfricanBusinessDays(received.toISOString().slice(0, 10), 10)) return
  if (!recovery.valuationId || !recovery.valuationNoticePath || !recovery.valuationNoticeSha256) throw new Error("The seeded TLB has no immutable valuation notice")
  const notice = [recovery.valuationId, recovery.valuationNoticePath, recovery.valuationNoticeSha256, recovery.valuationNoticeIssuedOn?.toISOString(), received.toISOString(), recovery.valuationReceiptReference]
  await ensureActorSessions(sim.actors)
  const { officer, admin } = sim.actors
  if (!officer.user?.id || !admin.user?.id || officer.user.id === admin.user.id || !officer.user.totpVerified || !admin.user.totpVerified || officer.user.tenantId !== tenant.id || admin.user.tenantId !== tenant.id) throw new Error("Seed recovery requires distinct verified staff in its tenant")
  const post = async (actor: SimClient, path: string, body: Record<string, unknown> = {}) => {
    const response = await actor.post<{ id?: string }>(path, body)
    if (![200, 201].includes(response.status)) throw new Error(`Seed recovery refused ${path}: ${response.status}`)
    return response.json
  }
  const refresh = async () => { recovery = (await load())[0]; if (!recovery) throw new Error("Seeded TLB recovery disappeared") }
  const base = `/api/asset-finance/recoveries/${recovery.id}`
  if (recovery.status === "VALUATION_NOTICE_ISSUED") { await post(officer, `${base}/list`); await refresh() }
  if (recovery.status === "LISTED") {
    const costs = recovery.costs.filter(c => c.supplierInvoiceRef === "STR-TLB-001")
    if (costs.length > 1) throw new Error("Seeded TLB storage cost is ambiguous")
    let cost = costs[0]
    if (!cost) {
      await post(officer, `${base}/costs`, { type: "STORAGE", netCents: 650_000, vatCents: 0, supplierInvoiceRef: "STR-TLB-001", incurredOn: today, treatment: "DEDUCT_FROM_PROCEEDS", note: "Yard storage" })
      await refresh(); cost = recovery.costs.find(c => c.supplierInvoiceRef === "STR-TLB-001")!
    }
    if (!cost || !["PENDING", "APPROVED"].includes(cost.status)) throw new Error("Seeded TLB storage cost was refused")
    if (cost.status === "PENDING") await post(admin, `${base}/costs/${cost.id}/decide`, { decision: "APPROVED" })
    const sales = recovery.sales.filter(s => s.buyerIdentifier === "2098/700001/07" && s.priceInclVatCents === 40_000_000)
    if (sales.length > 1 || recovery.sales.length !== sales.length) throw new Error("Seeded TLB sale is ambiguous")
    let sale = sales[0]
    if (!sale) {
      // A separate current assessment never overwrites the original notified valuation.
      const criteria = { tenantId: tenant.id, assetId: recovery.assetId, source: "ASSESSOR" as const, valuedOn: new Date(`${today}T00:00:00Z`), valuerName: "Synthetic independent assessor", amountCents: 45_000_000, createdById: officer.user.id }
      let assessment = await db.assetValuation.findFirst({ where: criteria, select: { id: true } })
      if (!assessment) {
        const created = await post(officer, `/api/asset-finance/assets/${recovery.assetId}/valuations`, { valuedOn: today, source: "ASSESSOR", valuerName: criteria.valuerName, amountCents: criteria.amountCents })
        if (!created?.id) throw new Error("Current TLB assessment returned no identity")
        assessment = { id: created.id }
      }
      await post(officer, `${base}/sales`, { channel: "AUCTION", buyerType: "ENTITY", buyerName: "Synthetic Demo Plant Buyer", buyerIdentifier: "2098/700001/07", buyerAddress: "9 Demo Industrial Road, Germiston, 1401", buyerVatNumber: null, priceInclVatCents: 40_000_000, valuationId: assessment.id, belowValuationReason: "Highest synthetic auction bid; hydraulic wear found at inspection" })
      await refresh(); sale = recovery.sales[0]
    }
    if (!sale || !["PENDING_APPROVAL", "APPROVED"].includes(sale.status)) throw new Error("Seeded TLB sale cannot be completed")
    if (sale.status === "PENDING_APPROVAL") await post(admin, `${base}/sales/${sale.id}/approve`)
    await post(officer, `${base}/sales/${sale.id}/complete`); await refresh()
  }
  if (recovery.status === "SOLD") { await post(admin, `${base}/proceeds`); await refresh() }
  if (recovery.status === "PROCEEDS_APPLIED") { await post(officer, `${base}/final-notice`); await refresh() }
  if (recovery.status === "FINAL_NOTICE_ISSUED") { await post(officer, `${base}/outcome`); await refresh() }
  const after = [recovery.valuationId, recovery.valuationNoticePath, recovery.valuationNoticeSha256, recovery.valuationNoticeIssuedOn?.toISOString(), recovery.valuationNoticeReceivedOn?.toISOString(), recovery.valuationReceiptReference]
  if (JSON.stringify(after) !== JSON.stringify(notice)) throw new Error("Original seeded TLB valuation notice changed")
  await refreshDpd()
}
