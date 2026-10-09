import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { computeQualification } from "@/lib/qualify"
import { PortalApplyClient } from "./PortalApplyClient"
import { getDefaultTenantId } from "@/lib/tenant"
import { formatProductRange, getPublicLoanProduct, type PublicLoanProductCode } from "@/lib/public-loan-products"
import { getLivePublicProductsServer } from "@/lib/public-loan-products-server"

export const metadata = {
  title: "Qualify & Apply",
}

export default async function PortalApplyPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getDefaultTenantId()

  const dbClient = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    include: { debtObligations: true },
  })

  const existingDebt = dbClient?.debtObligations.reduce(
    (sum, d) => sum + d.monthlyInstalment, 0
  ) ?? 0

  const clientData = dbClient
    ? {
        firstName: dbClient.firstName,
        monthlyIncome: dbClient.monthlyIncome,
        monthlyExpenses: dbClient.monthlyExpenses,
        existingDebt,
      }
    : null

  const qualification =
    dbClient && dbClient.monthlyIncome > 0
      ? computeQualification(dbClient.monthlyIncome, dbClient.monthlyExpenses, existingDebt)
      : null

  // Live amount ranges for the product cards (fail-open to static). PortalApply's
  // micro card ← the R500–R10,000 short-term product; personal ← personal; po ← PO.
  const products = await getLivePublicProductsServer()
  const rangeFor = (code: PublicLoanProductCode) =>
    formatProductRange(products.find((p) => p.code === code) ?? getPublicLoanProduct(code))
  const productRanges = {
    micro: rangeFor("short-term"),
    personal: rangeFor("personal"),
    po: rangeFor("purchase-order"),
  }

  return <PortalApplyClient client={clientData} qualification={qualification} productRanges={productRanges} />
}
