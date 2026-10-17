/**
 * Real-Postgres proof that a lease deal's staff page shows the rentals its
 * creation preview showed and its agreement PDF prints (Fair Score audit E1):
 * rental ex VAT, maintenance, VAT and total per period, the residual never paid
 * by the lessee, no loan schedule. An operating lease in advance for a sole
 * proprietor and a full-maintenance lease in arrears for a company, each
 * previewed, created, approved and prepared through the real routes. The FML
 * is prepared from a planned start a few days after the indicative one, so the
 * page must follow the prepared start the PDF prints. Only the session is
 * stubbed.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-deal-page.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { runWithTenant } from "@/lib/tenant-scope"
import { renderedText } from "@/components/asset-finance/lease/lease-test-helpers"
import { DealSummaryPanel } from "@/app/(dashboard)/asset-finance/deals/[id]/DealSummaryPanels"
import { LeaseScheduleSection } from "@/app/(dashboard)/asset-finance/deals/[id]/LeaseScheduleSection"
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { signingRoutes } from "./deal-signing.integration-fixture"
import { addMonthsClamped, fromDayNumber, toDayNumber } from "./dates"
import { formatMoney } from "./format"
import { loadDealDetail, type DealDetail } from "./deal-detail"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderLeaseAgreement } from "./documents/lease/agreement-pdf"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, type LeaseFixture } from "./lease.integration-fixture"
import type { LeaseScheduleView } from "./lease-view"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("next/link", async () => {
  const { createElement } = await import("react")
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children) }
})

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const pdfLines = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) =>
  [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) =>
    [...Buffer.from(m[1], "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join("")))

async function pageText(deal: DealDetail): Promise<string> {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  if (!deal.leaseSchedule) throw new Error("the deal page has no lease schedule")
  const schedule = deal.leaseSchedule
  let summary!: ReactTestRenderer
  let rentals!: ReactTestRenderer
  await act(async () => {
    summary = create(DealSummaryPanel({ deal }))
    rentals = create(LeaseScheduleSection({ deal, schedule }))
  })
  return `${renderedText(summary)}\n${renderedText(rentals)}`
}

const detail = (dealId: string) => runWithTenant(fx.tenantId, () => loadDealDetail(fx.tenantId, dealId))

/** Every figure the page shows for the schedule is the one the PDF prints. */
async function expectPageMatchesPdf(dealId: string, expectedStart: string): Promise<LeaseScheduleView> {
  const page = await detail(dealId)
  if (!page?.leaseSchedule?.ok) throw new Error(`no priced lease schedule: ${JSON.stringify(page?.leaseSchedule)}`)
  expect(page.leaseSchedule.prepared).toBe(true)
  expect(page.leaseSchedule.startDate).toBe(expectedStart)
  const data = await runWithTenant(fx.tenantId, () => loadDealDocumentData(prisma, fx.tenantId, dealId))
  if (!data?.lease) throw new Error("the deal's document data has no lease terms")
  expect(page.leaseSchedule.schedule).toEqual(data.lease.schedule)
  expect(data.pricing.startDate).toBe(expectedStart)

  const shown = await pageText(page)
  const printed = await pdfLines(await renderLeaseAgreement(data))
  const s = page.leaseSchedule.schedule
  const figures = [s.baseRentalCents, s.totalRentalExclVatCents, s.totalVatCents, s.totalCents, ...s.rows.map((r) => r.totalCents)]
  if (s.totalMaintenanceExclVatCents > 0) figures.push(s.totalMaintenanceExclVatCents, ...s.rows.map((r) => r.maintenanceExclVatCents))
  for (const cents of figures) {
    expect(shown).toContain(formatMoney(cents))
    expect(printed).toContain(formatZarPdf(cents))
  }
  // A lease page never shows a loan's schedule or terms.
  for (const word of ["Total interest", "Financed amount", "Balloon", "balloon", "Borrower", "Deposit", "Total payable"]) {
    expect(shown).not.toContain(word)
  }
  expect(shown).toContain("Lessee")
  expect(shown).toContain("Residual (not paid by the lessee)")
  return s
}

suite.sequential("lease deal page = create preview = agreement PDF (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
  }, 120_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("full-maintenance lease: the page shows the previewed rentals, maintenance and VAT, then the PDF's from the prepared start", async () => {
    const body = leaseBody(fx, { assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    staff(fx.officer, "CREDIT_OFFICER")
    const preview = (await (await dealRoutes(fx.host).preview(body)).json()) as { lease?: LeaseScheduleView; startDate?: string; error?: string }
    if (!preview.lease) throw new Error(`preview: ${JSON.stringify(preview)}`)
    const dealId = await approveLease(fx, staff, body)

    const indicative = await detail(dealId)
    if (!indicative?.leaseSchedule?.ok) throw new Error("no indicative lease schedule")
    expect(indicative.leaseSchedule.prepared).toBe(false)
    expect(indicative.leaseSchedule.startDate).toBe(preview.startDate)
    expect(indicative.leaseSchedule.schedule).toEqual(preview.lease)
    expect(indicative.leaseSchedule.schedule.totalMaintenanceExclVatCents).toBeGreaterThan(0)

    const plannedStart = fromDayNumber(toDayNumber(sastCalendarDate(new Date())) + 5)
    staff(fx.officer, "CREDIT_OFFICER")
    const prepared = await signingRoutes(fx.host).prepare(dealId, { plannedStartDate: plannedStart })
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const contract = await expectPageMatchesPdf(dealId, plannedStart)
    // The residual is the capital left after the last rental, never a payment: no row carries it.
    expect(contract.rows.every((r) => r.totalCents < 30_000_000)).toBe(true)
  }, 180_000)

  it("operating lease in advance: the page shows the previewed rentals and the PDF's once prepared", async () => {
    const firstDue = addMonthsClamped(sastCalendarDate(new Date()), 1)
    const body = leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee,
      rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", firstDueDate: firstDue,
      usageAllowancePerYear: 30_000, usageUnit: "KM", excessRateCents: 250,
    })
    staff(fx.officer, "CREDIT_OFFICER")
    const preview = (await (await dealRoutes(fx.host).preview(body)).json()) as { lease?: LeaseScheduleView; error?: string }
    if (!preview.lease) throw new Error(`preview: ${JSON.stringify(preview)}`)
    const dealId = await approveLease(fx, staff, body)
    const indicative = await detail(dealId)
    if (!indicative?.leaseSchedule?.ok) throw new Error("no indicative lease schedule")
    expect(indicative.leaseSchedule.schedule).toEqual(preview.lease)
    expect(indicative.contractType).toBe("OPERATING_LEASE")

    staff(fx.officer, "CREDIT_OFFICER")
    const prepared = await signingRoutes(fx.host).prepare(dealId, { plannedStartDate: firstDue })
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const contract = await expectPageMatchesPdf(dealId, firstDue)
    expect(contract.totalMaintenanceExclVatCents).toBe(0)
  }, 180_000)
})
