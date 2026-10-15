import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { COLLECTIBLE_STATUSES, SETTLED_STATUSES } from "@/lib/loan/collectible-book"
import { sastMonthBounds } from "@/lib/compliance/quarters"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { BoardPackClient } from "@/components/reports/BoardPackClient"
import { getStaffTenantId } from "@/lib/session-tenant"
import { findLenderIdentity, getLenderBrandName } from "@/lib/config/identity"
import { getPortfolioPar } from "@/lib/reports/par"
import { computeCollectionsRate, computeArrearsRate } from "@/lib/reports/collections-rate"
import { chargesOwing, loadChargesOwingByBand } from "@/lib/reports/charges-owing"
import { boardPackChargesSummary, loadDefaultChargesReport } from "@/lib/reports/default-charges-loader"
import { BoardPackDefaultCharges } from "@/components/reports/BoardPackDefaultCharges"
import { borrowerDisplayName } from "@/lib/borrower"

export default async function BoardPackPage() {
  const tenantId = await getStaffTenantId()
  const [lenderName, lender] = await Promise.all([getLenderBrandName(tenantId), findLenderIdentity(tenantId)])
  const now = new Date()
  // End-EXCLUSIVE SAST month bounds — see lib/compliance/quarters.ts. The
  // previous `lte new Date(y, m + 1, 0)` dropped the last day of the month
  // from both the expected and the received side of the collection figures.
  const { start: monthStart, end: monthEndExclusive } = sastMonthBounds(now)

  const [loans, collectibleBook, clients, arrears, insurance, topLoans, disbursements, expectedPayments, actualPayments, topDelinquent, par, charges, chargesSettled] = await Promise.all([
    // ACTIVE-only — feeds the "Loan Book" headline card only (book,
    // activeLoans below). Not the Collections/Arrears Rate denominator; see
    // collectibleBook.
    prisma.loan.aggregate({ where: { tenantId, status: "ACTIVE" }, _count: true, _sum: { outstandingPrincipal: true } }),
    // The collectible book (lib/loan/collectible-book.ts) — the denominator for
    // Collections Rate / Arrears Rate below, and for PAR. It must share its
    // population with `arrears` just below; see lib/reports/collections-rate.ts
    // for what mixing them produced last time (-175% collections rate).
    prisma.loan.aggregate({ where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] } }, _count: true, _sum: { outstandingPrincipal: true } }),
    prisma.client.count({ where: { tenantId, loans: { some: { status: "ACTIVE" } } } }),
    // Same collectible-book population as `collectibleBook` above and as
    // topDelinquent below, so an account that shows up in "Top Delinquent
    // Accounts" also shows up in the aging buckets and the Arrears Rate
    // numerator, not just one or the other.
    prisma.loan.findMany({
      where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gt: 0 } },
      select: { daysInArrears: true, arrearsAmount: true, outstandingPrincipal: true, ncaRegime: true },
    }),
    prisma.insurancePolicy.aggregate({ where: { tenantId, status: "ACTIVE" }, _count: true, _sum: { premiumAmount: true } }),
    // Loans still owed only (the collectible book) — a settled loan owes nothing.
    // Reference breaks ties so equal principals list in a stable order.
    prisma.loan.findMany({
      where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] } },
      orderBy: [{ principal: "desc" }, { reference: "asc" }], take: 10,
      include: {
        client: { select: { firstName: true, lastName: true } },
        entity: { select: { legalName: true } },
        product: { select: { name: true, productType: true } },
      },
    }),
    prisma.loan.aggregate({ where: { tenantId }, _count: true, _sum: { principal: true } }),
    prisma.repaymentSchedule.aggregate({
      // A reversed loan's cancelled rows (lib/payouts/reversal-effects.ts) are not due.
      where: { tenantId, dueDate: { gte: monthStart, lt: monthEndExclusive }, status: { not: "CANCELLED" } },
      _sum: { totalDue: true },
    }),
    prisma.payment.aggregate({
      where: {
        tenantId,
        receivedAt: { gte: monthStart, lt: monthEndExclusive },
        reversed: false,
        allocationStatus: "ALLOCATED",
        ...CASH_RECEIPTS,
      },
      _sum: { amount: true },
    }),
    prisma.loan.findMany({
      where: { tenantId, status: { in: [...COLLECTIBLE_STATUSES] }, daysInArrears: { gte: 30 } },
      orderBy: { daysInArrears: "desc" },
      take: 5,
      include: { client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } },
    }),
    getPortfolioPar(tenantId),
    // Default charges owing: beside the instalment arrears, never inside them.
    loadChargesOwingByBand(prisma, tenantId, [...COLLECTIBLE_STATUSES]),
    prisma.loan.aggregate({ where: { tenantId, status: { in: [...SETTLED_STATUSES] } }, _sum: { chargesOutstanding: true } }),
  ])
  const chargesSummary = charges.chargesLive
    ? boardPackChargesSummary(
        await loadDefaultChargesReport(prisma, tenantId, now), charges, chargesSettled._sum.chargesOutstanding ?? 0, now,
      )
    : null

  const byProduct = await prisma.loan.groupBy({
    by: ["productId"], where: { tenantId, status: "ACTIVE" },
    _count: true, _sum: { outstandingPrincipal: true },
  })
  const products = await prisma.loanProduct.findMany({ where: { tenantId }, select: { id: true, name: true, productType: true } })

  const arrearsLoans = arrears.length
  const collectibleLoanCount = collectibleBook._count
  const collectibleBookAmount = Number(collectibleBook._sum.outstandingPrincipal || 0)
  const collectionsRate = computeCollectionsRate(collectibleLoanCount, arrearsLoans)
  const book = Number(loans._sum.outstandingPrincipal || 0)
  const totalArrears = arrears.reduce((s, l) => s + l.arrearsAmount, 0)
  // Principal over principal, the reports overview's at-risk book %. Arrears
  // amounts carry interest and fees, so dividing them by a principal book
  // mixed two bases.
  const atRiskPrincipal = arrears.reduce((s, l) => s + l.outstandingPrincipal, 0)
  const arrearsRate = computeArrearsRate(atRiskPrincipal, collectibleBookAmount)

  // NPL + PAR — value-weighted on the collectible book (lib/reports/par), the single
  // definition shared with the dashboard, collections, reports and NCR return.
  const nplAmount = par.par90.value
  const nplRatio = par.par90.pct.toFixed(1)
  const par30 = par.par30.pct.toFixed(1)
  const par60 = par.par60.pct.toFixed(1)
  const par90 = par.par90.pct.toFixed(1)

  // Collection rate
  const expectedTotal = Number(expectedPayments._sum.totalDue || 0)
  const actualTotal = Number(actualPayments._sum.amount || 0)
  const monthlyCollectionRate = expectedTotal > 0 ? ((actualTotal / expectedTotal) * 100).toFixed(1) : "100.0"

  const buckets = [
    { label: "1-30 DPD", count: arrears.filter(l => l.daysInArrears >= 1 && l.daysInArrears <= 30).length, value: arrears.filter(l => l.daysInArrears >= 1 && l.daysInArrears <= 30).reduce((s, l) => s + l.arrearsAmount, 0) },
    { label: "31-60 DPD", count: arrears.filter(l => l.daysInArrears >= 31 && l.daysInArrears <= 60).length, value: arrears.filter(l => l.daysInArrears >= 31 && l.daysInArrears <= 60).reduce((s, l) => s + l.arrearsAmount, 0) },
    // 61-89 / 90+, not 61-90 / >90. A loan at exactly 90 DPD belongs in the
    // 90+ bucket: PAR90 and NPL are `>= 90` everywhere else in the app
    // (app/(dashboard)/reports/page.tsx, lib/compliance/ncr-return.ts), so the
    // old boundary put it in 61-90 here and in PAR90 there — the same
    // reconciliation defect fixed on the reports overview as review L-2.
    { label: "61-89 DPD", count: arrears.filter(l => l.daysInArrears >= 61 && l.daysInArrears <= 89).length, value: arrears.filter(l => l.daysInArrears >= 61 && l.daysInArrears <= 89).reduce((s, l) => s + l.arrearsAmount, 0) },
    { label: "90+ DPD", count: arrears.filter(l => l.daysInArrears >= 90).length, value: arrears.filter(l => l.daysInArrears >= 90).reduce((s, l) => s + l.arrearsAmount, 0) },
  ].map((b) => (charges.chargesLive ? { ...b, charges: charges.byBand[b.label as keyof typeof charges.byBand] } : b))

  // The aging covers the whole book; the NON_NCA (asset finance) share is
  // stated separately, because those agreements are not NCA-regulated.
  const nonNcaInArrears = arrears.filter(l => l.ncaRegime === "NON_NCA")
  const nonNcaArrears = { count: nonNcaInArrears.length, value: nonNcaInArrears.reduce((s, l) => s + l.arrearsAmount, 0) }

  const productMix = byProduct.map(b => ({
    name: products.find(p => p.id === b.productId)?.name || "Unknown",
    type: products.find(p => p.id === b.productId)?.productType || "MICRO",
    count: b._count,
    value: Number(b._sum.outstandingPrincipal || 0),
  }))

  const delinquentAccounts = topDelinquent.map(l => ({
    clientName: borrowerDisplayName(l),
    daysInArrears: l.daysInArrears,
    arrearsAmount: l.arrearsAmount,
    ...(charges.chargesLive ? { chargesOwing: chargesOwing(l, charges.chargesLive) } : {}),
    outstandingPrincipal: Number(l.outstandingPrincipal),
    reference: l.reference,
  }))

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Reports", href: "/reports" },
          { label: "Board pack" },
        ]}
      />
      <BoardPackClient
        lenderName={lenderName} ncrNumber={lender?.ncrNumber ?? null}
        book={book} activeLoans={loans._count} clients={clients}
        collectionsRate={collectionsRate} arrearsRate={arrearsRate}
        totalArrears={totalArrears} buckets={buckets} nonNcaArrears={nonNcaArrears}
        topLoans={topLoans} productMix={productMix}
        insurancePolicies={insurance._count} monthlyPremiums={Number(insurance._sum.premiumAmount ?? 0)}
        totalDisbursed={Number(disbursements._sum.principal || 0)}
        nplRatio={nplRatio} nplAmount={nplAmount}
        par30={par30} par60={par60} par90={par90}
        monthlyCollectionRate={monthlyCollectionRate}
        delinquentAccounts={delinquentAccounts}
        defaultCharges={chargesSummary && <BoardPackDefaultCharges summary={chargesSummary} />}
      />
    </div>
  )
}
