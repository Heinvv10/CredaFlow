/**
 * Renders the PASQ and CREDIT AGREEMENT variants to disk so the legal reviewer
 * can eyeball the actual documents before the approved-render pin in
 * lib/pdf/__tests__/creditAgreement.test.ts is moved.
 *
 * The pin must NEVER be updated from a passing text assertion alone — it exists
 * because a legal artefact was signed off as a RENDER. Run this, open both
 * PDFs, then re-pin only on explicit approval.
 *
 *   npx tsx scripts/ops/render-pasq-review.ts <output-dir>
 *
 * Fixture mirrors lib/pdf/__tests__/creditAgreement.test.ts baseInput exactly,
 * so the bytes this writes are the bytes the pin hashes.
 */
import { writeFileSync } from "node:fs"
import { generateCreditAgreementPdf } from "../../lib/pdf/creditAgreement"
import { ACME_LENDER } from "../../lib/config/__fixtures__/lender-identity"

const baseInput = {
  variant: "pasq" as const,
  lender: ACME_LENDER,
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8503015800086",
    addressLine1: "45 Oak Avenue",
    city: "Soweto",
  },
  application: {
    reference: "APP-001",
    agreementType: "Short-term Credit",
    appliedTermDays: 30,
  },
  calc: {
    principal: 500000,
    initiationFee: 57500,
    totalInterest: 25000,
    totalRepayable: 582500,
    disbursementAmount: 500000,
    monthlyInstalment: 582500,
    serviceFees: 6900,
    schedule: [
      {
        installmentNo: 1,
        dueDate: new Date("2026-06-01"),
        openingBalance: 500000,
        principalDue: 500000,
        interestDue: 25000,
        feesDue: 6900,
        totalDue: 582500,
        closingBalance: 0,
      },
    ],
  },
  product: {
    interestRatePm: 0.05,
    interestModel: "FLAT",
    monthlyServiceFee: 6900,
  },
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-06-14"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
}

async function main() {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error("usage: npx tsx scripts/ops/render-pasq-review.ts <output-dir>")
    process.exit(2)
  }
  const pasq = await generateCreditAgreementPdf({ ...baseInput, variant: "pasq" })
  writeFileSync(`${outDir}/pasq-AFTER.pdf`, pasq)
  const agreement = await generateCreditAgreementPdf({ ...baseInput, variant: "agreement" })
  writeFileSync(`${outDir}/agreement-AFTER.pdf`, agreement)
  // Credit-life variant too: the CL block can push the signature area onto a
  // continuation page, which is the layout most at risk from this edit.
  // Carries REAL election evidence, not just willAutoBundleCl — the premium
  // disclosure rows only render when `creditLife` is present, so a flag-only
  // fixture cannot show where the premium actually lands on the page.
  const pasqCl = await generateCreditAgreementPdf({
    ...baseInput,
    variant: "pasq",
    willAutoBundleCl: true,
    creditLife: {
      elected: true,
      productName: "Acme Credit Life",
      insurerName: "Test Life Ltd",
      monthlyPremiumCents: 2250,
      premiumPeriods: 1,
      totalPremiumCents: 2250,
      // Accepted cover throws without PASQ-bound billing evidence, so the
      // premium rows never render from a flag-only fixture.
      billing: {
        version: "credit-life-billing-v1",
        collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
        recurringPaymentCents: 584750,
        totalRepayableCents: 584750,
        schedule: [
          {
            installmentNo: 1,
            openingBalanceCents: 500000,
            principalDueCents: 500000,
            interestDueCents: 25000,
            feesDueCents: 9150,
            totalDueCents: 584750,
            closingBalanceCents: 0,
          },
        ],
      },
    } as never,
  })
  writeFileSync(`${outDir}/pasq-creditlife-AFTER.pdf`, pasqCl)
  console.log(`wrote 3 PDFs to ${outDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
