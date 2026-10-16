import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect, notFound } from "next/navigation"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import { computeQualification } from "@/lib/qualify"
import { PortalApplyProductClient } from "./PortalApplyProductClient"
import { isCreditLifeAutoBundleEnabled } from "@/lib/insurance/credit-life-containment"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"

// Resolve by tenant-scoped UNIQUE product code, never by productType:
// two products can both be productType MICRO, and type+creation-order
// resolution silently picks whichever row is older — the portal would apply
// against the wrong product (range, rate, fees) the moment another MICRO
// product is added. Codes pin the exact product each portal card sells.
const PRODUCT_KEY_TO_CODE: Record<string, string> = {
  micro: "MICRO30",
  personal: "PERSONAL",
  po: "POFUND",
}

export const metadata = {
  title: "Apply",
}

export default async function PortalApplyProductPage({
  params,
}: {
  params: Promise<{ product: string }>
}) {
  const { product: productKey } = await params

  const productCode = PRODUCT_KEY_TO_CODE[productKey]
  if (!productCode) notFound()

  const session = await auth()
  if (!session?.user?.email || session.user.role !== "CLIENT") {
    redirect("/portal/login")
  }

  const tenantId = await getPortalTenantId()
  const identity = await getLenderIdentity(tenantId)

  const [client, product, creditLifeProduct] = await Promise.all([
    prisma.client.findFirst({
      where: { email: session.user.email, tenantId },
      include: { debtObligations: true },
    }),
    prisma.loanProduct.findFirst({
      where: { tenantId, code: productCode, active: true, ...CONSUMER_PRODUCT_WHERE },
    }),
    prisma.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(tenantId)),
  ])

  if (!client) redirect("/portal/login")
  if (!product) notFound()

  const existingDebt = client.debtObligations.reduce(
    (sum, d) => sum + d.monthlyInstalment,
    0,
  )

  const qualification = client.monthlyIncome > 0
    ? computeQualification(client.monthlyIncome, client.monthlyExpenses, existingDebt)
    : null

  return (
    <PortalApplyProductClient
      productKey={productKey}
      lenderName={identity.tradingName}
      ncrNumber={identity.ncrNumber}
      product={{
        id: product.id,
        name: product.name,
        code: product.code,
        productType: product.productType,
        minAmount: product.minAmount,
        maxAmount: product.maxAmount,
        minTermDays: product.minTermDays,
        maxTermDays: product.maxTermDays,
      }}
      client={{
        firstName: client.firstName,
        lastName: client.lastName,
        idNumber: client.idNumber,
        phone: client.phone,
        email: client.email,
        monthlyIncome: client.monthlyIncome,
        monthlyExpenses: client.monthlyExpenses,
        existingDebt,
      }}
      qualification={qualification}
      creditLifeOffer={
        creditLifeProduct?.insurerId
        && creditLifeProduct.insurer
        && creditLifeProduct.name.trim() !== ""
        && creditLifeProduct.insurer.name.trim() !== ""
          ? {
              productId: creditLifeProduct.id,
              productName: creditLifeProduct.name,
              insurerId: creditLifeProduct.insurerId,
              insurerName: creditLifeProduct.insurer.name,
              autoBundleEnabled: isCreditLifeAutoBundleEnabled(),
            }
          : null
      }
    />
  )
}
