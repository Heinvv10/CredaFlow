import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { computeQualification, type QualificationBounds } from "@/lib/qualify"
import { PortalApplyClient } from "./PortalApplyClient"
import { getPortalTenantId } from "@/lib/session-tenant"
import { portalExistingDebt } from "@/lib/affordability/portal-own-lender-debt"
import { formatProductRange, getPublicLoanProduct, type PublicLoanProductCode } from "@/lib/public-loan-products"
import { getLivePublicProductsServer } from "@/lib/public-loan-products-server"
import { getLocale } from "@/lib/i18n/server"
import { formatDay } from "@/lib/i18n/format"

/**
 * How long after a decline the portal stops presenting "You qualify" figures.
 * Thirty days: long enough that a client declined this month is not told the
 * opposite on the next screen, short enough that a changed situation is seen.
 */
const RECENT_DECLINE_DAYS = 30

export const metadata = {
  title: "Qualify & Apply",
}

export default async function PortalApplyPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getPortalTenantId()

  const dbClient = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    include: { debtObligations: true },
  })

  // The client's loans with this lender count too, as in the staff assessment
  // (lib/affordability/own-lender-debt.ts): they do not declare them.
  const { existingDebt, ownLenderArrears } = dbClient
    ? await portalExistingDebt(prisma, tenantId, dbClient.id, dbClient.debtObligations)
    : { existingDebt: 0, ownLenderArrears: null }

  const clientData = dbClient
    ? {
        firstName: dbClient.firstName,
        monthlyIncome: dbClient.monthlyIncome,
        monthlyExpenses: dbClient.monthlyExpenses,
        existingDebt,
      }
    : null

  // Live amount ranges for the product cards (fail-open to static). PortalApply's
  // micro card ← the short-term product; personal ← personal; po ← PO. The same
  // ranges bound the qualification, so no card offers more than a product lends.
  const products = await getLivePublicProductsServer()
  const productFor = (code: PublicLoanProductCode) => products.find((p) => p.code === code) ?? getPublicLoanProduct(code)
  const productRanges = {
    micro: formatProductRange(productFor("short-term")),
    personal: formatProductRange(productFor("personal")),
    po: formatProductRange(productFor("purchase-order")),
  }
  const boundsOf = ({ minAmount, maxAmount }: { minAmount: number; maxAmount: number }) => ({ minAmount, maxAmount })
  const bounds: QualificationBounds = {
    micro: boundsOf(productFor("short-term")),
    personal: boundsOf(productFor("personal")),
    po: boundsOf(productFor("purchase-order")),
  }

  // No "you qualify" figures while overdue with this lender (PortalApplyClient shows why).
  const qualification =
    dbClient && dbClient.monthlyIncome > 0 && !ownLenderArrears
      ? computeQualification(dbClient.monthlyIncome, dbClient.monthlyExpenses, existingDebt, bounds)
      : null

  // A decline's decision time is approvedAt (the decide route stamps it for
  // both outcomes); updatedAt covers a decline written without it.
  const now = new Date()
  const since = new Date(now.getTime() - RECENT_DECLINE_DAYS * 86_400_000)
  const declined = dbClient
    ? await prisma.loanApplication.findFirst({
        where: {
          tenantId,
          clientId: dbClient.id,
          status: "DECLINED",
          OR: [{ approvedAt: { gte: since } }, { approvedAt: null, updatedAt: { gte: since } }],
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, reference: true, approvedAt: true, updatedAt: true },
      })
    : null
  const recentDecline = declined
    ? {
        id: declined.id,
        reference: declined.reference,
        decidedOn: formatDay(declined.approvedAt ?? declined.updatedAt, await getLocale()),
      }
    : null

  return (
    <PortalApplyClient
      client={clientData}
      qualification={qualification}
      productRanges={productRanges}
      bounds={bounds}
      recentDecline={recentDecline}
      ownLenderArrears={ownLenderArrears}
    />
  )
}
