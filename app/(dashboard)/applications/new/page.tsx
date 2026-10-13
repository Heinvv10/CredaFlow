import { Suspense } from "react"
import { redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { ApplicationWizard } from "@/components/applications/wizard/ApplicationWizard"
import type { ClientWithFinancials } from "@/components/applications/wizard/ApplicationWizard"
import {
  EMPTY_APPLICATION_WIZARD_DATA,
  type ApplicationProduct,
  type ApplicationWizardData,
} from "@/components/applications/wizard/types"
import { toApplicationProduct } from "@/lib/applications/product-mapper"
import { compareProductsForCapture } from "@/lib/applications/product-order"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { isCreditLifeAutoBundleEnabled } from "@/lib/insurance/credit-life-containment"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"

async function getData(tenantId: string) {
  const [clientRows, productRows, creditLifeProduct] = await Promise.all([
    prisma.client.findMany({
      // A deceased client is excluded from the picker for the same reason a
      // blacklisted one is: this list is the set of people staff may start a
      // new credit agreement for.
      where: { tenantId, blacklisted: false, deceasedAt: null },
      orderBy: { lastName: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        monthlyIncome: true,
        monthlyExpenses: true,
        debtObligations: {
          select: { monthlyInstalment: true },
        },
      },
    }),
    prisma.loanProduct.findMany({
      where: { tenantId, active: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        minAmount: true,
        maxAmount: true,
        minTermDays: true,
        maxTermDays: true,
        interestRatePm: true,
        interestModel: true,
        initiationFeeModel: true,
        initiationFeePct: true,
        initiationFeeMax: true,
        monthlyServiceFee: true,
        productType: true,
      },
    }),
    prisma.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(tenantId)),
  ])

  // Coerce Prisma Decimal / Int to plain number; shape as wizard types.
  const clients: ClientWithFinancials[] = clientRows.map((c) => ({
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    monthlyIncome: Number(c.monthlyIncome),
    monthlyExpenses: Number(c.monthlyExpenses),
    debtObligations: c.debtObligations.map((d) => ({
      monthlyInstalment: Number(d.monthlyInstalment),
    })),
  }))

  const products: ApplicationProduct[] = productRows
    .map(toApplicationProduct)
    .sort(compareProductsForCapture)

  const creditLifeOffer =
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

  return { clients, products, creditLifeOffer }
}

async function loadDraftForResume(id: string, tenantId: string) {
  return prisma.loanApplication.findFirst({
    where: { id, tenantId, status: "DRAFT" },
    select: {
      id: true,
      clientId: true,
      productId: true,
      appliedAmount: true,
      appliedTermDays: true,
      purpose: true,
      loanPurposeCategory: true,
    },
  })
}

type DraftForResume = NonNullable<Awaited<ReturnType<typeof loadDraftForResume>>>

// Inverse of the create-time mapping in lib/applications/prepare-application.ts:
// cents → rand string, enum/null → string. The affordability snapshot fields
// (monthlyInstalment/totalInterest/totalRepayable/affordabilityFlag) are left
// at their EMPTY_APPLICATION_WIZARD_DATA defaults — Step3Affordability
// recomputes them from live product/client data once the wizard reaches that
// step, the same as a fresh application.
function toWizardData(draft: DraftForResume): ApplicationWizardData {
  return {
    ...EMPTY_APPLICATION_WIZARD_DATA,
    clientId: draft.clientId,
    productId: draft.productId,
    appliedAmount: String(draft.appliedAmount / 100),
    appliedTermDays: String(draft.appliedTermDays),
    purpose: draft.purpose ?? "",
    loanPurposeCategory: draft.loanPurposeCategory ?? "",
  }
}

interface PageProps {
  searchParams: Promise<{ id?: string }>
}

export default async function NewApplicationPage({ searchParams }: PageProps) {
  const { id } = await searchParams
  const tenantId = await getStaffTenantId()
  const [{ clients, products, creditLifeOffer }, draft] = await Promise.all([
    getData(tenantId),
    id ? loadDraftForResume(id, tenantId) : Promise.resolve(null),
  ])

  // A draft id that doesn't resolve (wrong tenant, wrong status, or doesn't
  // exist) sends staff to the detail page instead of a blank wizard — it
  // shows why the resume link no longer applies (already submitted, or a
  // stale/bad link) rather than silently starting a new application.
  if (id && !draft) {
    redirect(`/applications/${id}`)
  }

  const resuming = !!draft

  return (
    <>
      <Header
        title={resuming ? "Edit Draft Application" : "New Application"}
        subtitle={resuming ? "Continue this saved draft" : "Create a new loan application"}
        breadcrumbs={[
          { label: "Applications", href: "/applications" },
          { label: resuming ? "Edit draft" : "New application" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <Suspense
          fallback={
            <div className="text-[var(--cf-text-muted)] p-6">Loading…</div>
          }
        >
          <ApplicationWizard
            mode="staff"
            clients={clients}
            products={products}
            applicationId={draft?.id}
            initialData={draft ? toWizardData(draft) : undefined}
            creditLifeOffer={creditLifeOffer}
          />
        </Suspense>
      </div>
    </>
  )
}
